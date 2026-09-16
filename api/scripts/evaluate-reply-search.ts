// Opt-in paid component evaluation. Uses anonymised, shortened support examples;
// never reads customer records, reserves workspace credit or writes to a database.
import { anthropic, computeCostMicro } from '../src/lib/anthropic.js';
import { RANK, EXPAND, REPLY_RANK_INSTRUCTIONS, expansionInstructions, expandedReplyTerms } from '../src/lib/meaningful-replies.js';
import { replyTerms } from '../src/lib/previous-replies.js';

if (!process.argv.includes('--live')) throw new Error('Pass --live to run the paid model evaluation.');
const candidates = [
  { id:'C1',title:'Bono de casino',question:'No se me acreditó mi bono de bienvenida',reply:'Hola {name}. No recibiste tus giros gratis de bienvenida. Hubo un problema técnico con el abono automático cuando cumpliste los requisitos de apuesta. Tus giros gratis han sido acreditados manualmente en {game}.' },
  { id:'C2',title:'No me han dado mis giros gratis',question:'De bono de bienvenida',reply:'Hola {name}. No cumpliste el requisito de apuesta de tu primer depósito, ya que retiraste el saldo antes de apostar el importe completo. Como gesto de buena voluntad en esta ocasión, he acreditado manualmente los giros gratuitos.' },
  { id:'C3',title:'no me deja verificar mi cuenta',question:'aquí está mi id para verificarla',reply:'Hola {name}. Gracias por tus documentos de identificación. En este momento no necesitamos ningún documento de tu parte. Si en el futuro necesitamos algo, nos pondremos en contacto contigo.' },
  { id:'C4',title:'Account closure request',question:'I think I had an account many years ago. If it still exists, please permanently close it.',reply:'Hello {name}. We could not locate an account with the email addresses provided. Please provide further identifying details so we can look again and close any account found.' },
];
const cases: [string,string,string[]][] = [
  ['Spanish bonus','No se me acreditó mi bono de bienvenida',['C1','C2']],
  ['English bonus','My welcome free spins never appeared after I played through my first deposit.',['C1']],
  ['Verification','Aquí está mi identificación para verificar mi cuenta.',['C3']],
  ['Closure','Please shut down my old account permanently. I cannot remember which email I registered with.',['C4']],
  ['Withdrawal','My bank withdrawal has not arrived. Where is my cash payment?',[]],
  ['Cash deposit','My card was charged but the deposit is missing from my cash balance.',[]],
  ['Reopening','I want to reopen my closed account and start using it again.',[]],
  ['Conflicting outcome','He apostado todo lo requerido y soporte confirmó que hay un fallo técnico con mis giros de bienvenida.',['C1']],
];
let costMicro=0, passed=0, total=0;
async function run(system: string, content: string, tool: typeof RANK) {
  const r=await anthropic.messages.create({ model:'claude-haiku-4-5',max_tokens:512,system,
    messages:[{role:'user',content}],tools:[tool],tool_choice:{type:'tool',name:tool.name} }, {timeout:8000,maxRetries:0});
  costMicro+=computeCostMicro('claude-haiku-4-5', { ...r.usage, cache_creation_input_tokens:r.usage.cache_creation_input_tokens || 0,
    cache_read_input_tokens:r.usage.cache_read_input_tokens || 0 });
  if(r.stop_reason==='max_tokens') throw new Error('Truncated evaluation response');
  const result=r.content.find(b=>b.type==='tool_use');
  return result?.type==='tool_use' ? result.input as any : null;
}
for(let repeat=1;repeat<=2;repeat++) {
  for(const [name,query,allowed] of cases) {
    const start=Date.now();
    const result=await run(REPLY_RANK_INSTRUCTIONS, JSON.stringify({query,candidates}),RANK);
    const ids=result?.ids;
    const pass=Array.isArray(ids) && ids.length<=3 && new Set(ids).size===ids.length
      && ids.every(id=>allowed.includes(id)) && (allowed.length ? ids.length>0 : ids.length===0);
    total++; if(pass) passed++;
    console.log(JSON.stringify({name,repeat,ids,pass,ms:Date.now()-start}));
  }
  const query=cases[1][1];
  const result=await run(expansionInstructions(['English','Spanish']),query,EXPAND);
  const terms=expandedReplyTerms(query,result?.phrases || []).split(' ');
  const overlap=replyTerms(candidates[0].title+' '+candidates[0].question).filter(t=>terms.includes(t));
  // Production retrieval uses OR terms; one shared indexed term admits the
  // candidate for relevance ranking (it does not use rankReplies' threshold).
  const pass=overlap.length>0;
  total++; if(pass) passed++;
  console.log(JSON.stringify({name:'English query finds Spanish wording',repeat,pass,overlap}));
}
console.log(JSON.stringify({passed,total,costMicro,scope:'model components; not full-corpus retrieval or draft generation'}));
if(passed!==total) process.exitCode=1;

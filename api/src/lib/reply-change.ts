// Linear-time character-pair overlap, including repeated pairs. A heuristic for
// wording change, not a correctness or productivity score. Translation counts.
export function replyChangeRatio(original: string, posted: string): number {
  const normalise = (text: string) => Array.from(text.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim());
  const a=normalise(original),b=normalise(posted);
  if(a.join('')===b.join(''))return 0;
  if(a.length<2||b.length<2)return 1;
  const pairs=new Map<string,number>();
  for(let i=1;i<a.length;i++){const key=a[i-1]+a[i];pairs.set(key,(pairs.get(key)||0)+1);}
  let shared=0;
  for(let i=1;i<b.length;i++){const key=b[i-1]+b[i],count=pairs.get(key)||0;if(count){shared++;pairs.set(key,count-1);}}
  return 1-(2*shared)/(a.length+b.length-2);
}

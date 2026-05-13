// ─── Data ─────────────────────────────────────────────────────────────────────
const AGENTS = [
  {name:'Emma Clarke', initials:'EC', role:'Admin',        active:true},
  {name:'James Webb',  initials:'JW', role:'Senior Agent', active:true},
  {name:'Sofia Reyes', initials:'SR', role:'Read Only',    active:true},
  {name:'Priya Nair',  initials:'PN', role:'Senior Agent', active:true, oooFrom:'2026-05-04', oooTo:'2026-05-08', oooNote:'Annual leave — back Friday'},
  {name:'Tom Bates',   initials:'TB', role:'Senior Agent', active:true},
];

let PERMISSIONS = [
  {key:'tickets',   label:'Tickets'},
  {key:'customers', label:'Customers'},
  {key:'reports',   label:'Reports'},
  {key:'ai',        label:'AI Intelligence'},
  {key:'workflows', label:'Workflows'},
  {key:'tags',      label:'Tags'},
  {key:'roles',     label:'Roles & Perms'},
  {key:'gdpr',      label:'GDPR Actions'},
];

const CUSTOMERS = [
  {id:'M001',first:'Sarah',last:'Mitchell',username:'smitchell',email:'sarah.m@acme.com',mobile:'+44 7700 100001',brand:'Acme Corp',vip:'Gold',jurisdiction:'UK',consent:true,kyc:'Verified',since:'2023-01-15',bo:'https://backoffice.example.com/M001',custom:{}},
  {id:'M002',first:'James',last:'Reed',username:'jreed',email:'james.r@globex.io',mobile:'+44 7700 100002',brand:'Globex',vip:'Silver',jurisdiction:'IE',consent:true,kyc:'Pending',since:'2022-11-03',bo:'https://backoffice.example.com/M002',custom:{}},
  {id:'M003',first:'Nina',last:'Kowalski',username:'nina_k',email:'nina@initech.com',mobile:'+49 151 20000003',brand:'Initech',vip:'Platinum',jurisdiction:'DE',consent:false,kyc:'Verified',since:'2021-06-20',bo:'https://backoffice.example.com/M003',custom:{}},
  {id:'M004',first:'Tom',last:'Brewer',username:'tbrewer',email:'tom@umbrella.co',mobile:'+44 7700 100004',brand:'Umbrella',vip:'Bronze',jurisdiction:'UK',consent:true,kyc:'Verified',since:'2023-08-11',bo:'https://backoffice.example.com/M004',custom:{}},
  {id:'M005',first:'Priya',last:'Sharma',username:'psharma',email:'priya@nakatomi.jp',mobile:'+81 90 0000 0005',brand:'Nakatomi',vip:'Gold',jurisdiction:'JP',consent:true,kyc:'Verified',since:'2020-03-07',bo:'https://backoffice.example.com/M005',custom:{}},
  {id:'M006',first:'Carlos',last:'Diaz',username:'cdiaz',email:'carlos@tyrell.com',mobile:'+1 415 000 0006',brand:'Tyrell',vip:'Silver',jurisdiction:'US',consent:true,kyc:'Pending',since:'2023-04-22',bo:'https://backoffice.example.com/M006',custom:{}},
];

const TICKETS = [
  {id:'TK-001',subject:'Payment not processing at checkout',customerId:'M001',status:'escalated',priority:'urgent',category:'Billing',agent:'Emma Clarke',created:'2025-04-16',updated:'2 min ago',sla:'breach',tags:['billing','payment'],aiTags:[{tag:'urgent-billing',conf:94,accepted:false},{tag:'checkout-issue',conf:87,accepted:false}],csat:null,
    msgs:[
      {from:'Sarah Mitchell',r:'customer',t:'Hi, I\'ve been trying to checkout for the past hour but my payment keeps failing. Tried two different cards. I need this order urgently.',ts:'09:12'},
      {from:'AI Agent',r:'ai',t:'Hi Sarah, I can see a temporary fraud-protection hold on transactions over £200 on your account. I\'ve escalated this to our payments team for immediate review. In the meantime, could you try PayPal as an alternative? You should hear back within 30 minutes.',ts:'09:12'},
      {from:'Sarah Mitchell',r:'customer',t:'PayPal doesn\'t work for me. This is really urgent, I have a deadline.',ts:'09:35'},
    ]},
  {id:'TK-002',subject:'Export transaction history to CSV',customerId:'M002',status:'open',priority:'normal',category:'Technical',agent:'James Webb',created:'2025-04-16',updated:'14 min ago',sla:'ok',tags:['export','data'],aiTags:[{tag:'data-export',conf:91,accepted:false}],csat:null,
    msgs:[
      {from:'James Reed',r:'customer',t:'I need to export all my transaction history to CSV for my accountant. Can\'t find the option anywhere in the dashboard settings.',ts:'09:00'},
    ]},
  {id:'TK-003',subject:'Account locked after password reset',customerId:'M003',status:'open',priority:'high',category:'Account',agent:'Emma Clarke',created:'2025-04-16',updated:'1h ago',sla:'warn',tags:['account','login'],aiTags:[{tag:'account-lock',conf:97,accepted:true}],csat:null,
    msgs:[
      {from:'Nina Kowalski',r:'customer',t:'I reset my password but now my account is locked. I have a client presentation in 2 hours and really need access.',ts:'08:15'},
      {from:'James Webb',r:'agent',t:'Hi Nina, the lockout triggers automatically after 3 failed attempts during the reset flow — I\'m unlocking it now. Please try again in 2 minutes.',ts:'08:22'},
    ]},
  {id:'TK-004',subject:'Resend March 2025 invoice',customerId:'M004',status:'pending',priority:'normal',category:'Billing',agent:'Sofia Reyes',created:'2025-04-16',updated:'3h ago',sla:'ok',tags:['invoice','billing'],aiTags:[{tag:'invoice-request',conf:99,accepted:true}],csat:null,
    msgs:[
      {from:'Tom Brewer',r:'customer',t:'Could you resend the invoice for March 2025? I\'ve accidentally deleted the email and need it for our quarterly accounts.',ts:'07:00'},
    ]},
  {id:'TK-005',subject:'GDPR data erasure request',customerId:'M005',status:'gdpr',priority:'high',category:'GDPR',agent:'Emma Clarke',created:'2025-04-15',updated:'1d ago',sla:'warn',tags:['gdpr','erasure'],aiTags:[{tag:'gdpr-erasure',conf:100,accepted:true}],csat:null,
    msgs:[
      {from:'Priya Sharma',r:'customer',t:'I am formally requesting erasure of all my personal data under GDPR Article 17. Please confirm within the statutory timeframe.',ts:'14:00'},
    ]},
  {id:'TK-006',subject:'Bulk user import feature request',customerId:'M005',status:'resolved',priority:'low',category:'Feature',agent:'Tom Bates',created:'2025-04-14',updated:'2d ago',sla:'ok',tags:['feature-request'],aiTags:[{tag:'feature-request',conf:95,accepted:true}],csat:4,csatStars:4,csatSubmittedAt:'2025-04-14',csatRequestedAt:'2025-04-14',csatComment:'Quick acknowledgement and clear roadmap. Would have liked an exact ETA.',timeEntries:[{id:'TE-A1B2C3',agent:'Tom Bates',minutes:25,note:'Logged feature request, replied to customer',billable:true,ts:'2025-04-14 11:05'}],
    msgs:[
      {from:'Priya Sharma',r:'customer',t:'It would be really helpful to import users in bulk via CSV rather than one by one. We have 200+ users to migrate.',ts:'11:00'},
      {from:'AI Agent',r:'ai',t:'Thanks Priya — logged as high-priority. It\'s on the Q3 roadmap and you\'ll be notified when it ships.',ts:'11:01'},
    ]},
  {id:'TK-007',subject:'iOS app very slow on iPhone 14',customerId:'M006',status:'resolved',priority:'normal',category:'Technical',agent:'James Webb',created:'2025-04-14',updated:'2d ago',sla:'ok',tags:['mobile','performance'],aiTags:[{tag:'mobile-bug',conf:88,accepted:true}],csat:5,csatStars:5,csatSubmittedAt:'2025-04-14',csatRequestedAt:'2025-04-14',csatComment:'James was incredibly responsive and the fix worked first try. Best support I\'ve had.',timeEntries:[{id:'TE-D4E5F6',agent:'James Webb',minutes:45,note:'Reproduced on iPhone 14, traced to image cache',billable:true,ts:'2025-04-14 10:30'},{id:'TE-G7H8I9',agent:'James Webb',minutes:30,note:'Wrote test, deployed fix',billable:true,ts:'2025-04-14 13:15'}],
    msgs:[
      {from:'Carlos Diaz',r:'customer',t:'The mobile app is unusably slow on my iPhone 14. The dashboard takes 8+ seconds to load.',ts:'10:00'},
      {from:'AI Agent',r:'ai',t:'Hi Carlos, we patched a performance regression affecting iOS 17 devices earlier today in v4.2.1. Could you update the app?',ts:'10:01'},
    ]},
];

const CUSTOM_FIELDS = [
  {id:'cf1',label:'Account Manager',type:'text',   entity:'customer', required:false, defaultValue:''},
  {id:'cf2',label:'Contract Value', type:'number', entity:'customer', required:false, defaultValue:''},
  {id:'cf3',label:'Renewal Date',   type:'date',   entity:'customer', required:false, defaultValue:''},
];

const WORKFLOWS = [
  {id:'WF-001',name:'Auto-escalate urgent billing',trigger:'Priority = Urgent AND Category = Billing',action:'Assign to Senior Agent + Notify Manager',status:'active',  runCount:14,lastRun:'2 hours ago'},
  {id:'WF-002',name:'GDPR 72h SLA alert',          trigger:'Category = GDPR AND Age > 72h',           action:'Send alert to DPO + Flag ticket',          status:'active',  runCount:3, lastRun:'1 day ago'},
  {id:'WF-003',name:'Auto-resolve after 7 days',   trigger:'Status = Pending AND Last updated > 7d',  action:'Set status = Resolved',                    status:'inactive',runCount:0, lastRun:null},
  {id:'WF-004',name:'Send CSAT survey on resolve', trigger:'Status changed to Resolved',              action:'Send satisfaction survey email',           status:'active',  runCount:42,lastRun:'15 min ago'},
];

const TAG_LIBRARY = [
  {tag:'billing',count:12,type:'manual',conf:null},
  {tag:'payment',count:8,type:'manual',conf:null},
  {tag:'account-lock',count:5,type:'ai',conf:97},
  {tag:'data-export',count:4,type:'ai',conf:91},
  {tag:'gdpr-erasure',count:3,type:'ai',conf:100},
  {tag:'invoice-request',count:7,type:'ai',conf:99},
  {tag:'mobile-bug',count:6,type:'ai',conf:88},
  {tag:'feature-request',count:9,type:'manual',conf:null},
  {tag:'urgent-billing',count:2,type:'ai',conf:94},
  {tag:'checkout-issue',count:3,type:'ai',conf:87},
];

const SLA_POLICIES = [
  {id:'SLA-001', name:'Urgent · Billing',   priority:'urgent', category:'Billing',   firstResponseMin:15,  resolutionMin:240,   status:'active'},
  {id:'SLA-002', name:'Urgent · GDPR',      priority:'urgent', category:'GDPR',      firstResponseMin:30,  resolutionMin:4320,  status:'active'},
  {id:'SLA-003', name:'High · Default',     priority:'high',   category:'all',       firstResponseMin:60,  resolutionMin:1440,  status:'active'},
  {id:'SLA-004', name:'Normal · Default',   priority:'normal', category:'all',       firstResponseMin:240, resolutionMin:2880,  status:'active'},
  {id:'SLA-005', name:'Low · Default',      priority:'low',    category:'all',       firstResponseMin:480, resolutionMin:7200,  status:'inactive'},
];

// Auto-assignment rules applied on ticket creation (and via Run rules action).
// Rules are evaluated by ascending priority (1 wins over 2). The first matching
// active rule fires; round-robin rules cycle through their team.
const ASSIGN_RULES = [
  {id:'AR-001', name:'Urgent · Billing → Sofia',  priority:1, status:'active',
   conditions:{priority:'urgent', category:'Billing', vip:'all'},
   assignment:{mode:'specific-agent', agent:'Sofia Reyes'},
   matchCount:9, lastMatchAt:'2025-04-15'},
  {id:'AR-002', name:'GDPR → Emma',               priority:2, status:'active',
   conditions:{priority:'all', category:'GDPR', vip:'all'},
   assignment:{mode:'specific-agent', agent:'Emma Clarke'},
   matchCount:4, lastMatchAt:'2025-04-15'},
  {id:'AR-003', name:'VIP gold → senior team',    priority:3, status:'active',
   conditions:{priority:'all', category:'all', vip:'Gold'},
   assignment:{mode:'least-busy', team:['Emma Clarke','Sofia Reyes']},
   matchCount:3, lastMatchAt:'2025-04-14'},
  {id:'AR-004', name:'Default round-robin',       priority:99, status:'active',
   conditions:{priority:'all', category:'all', vip:'all'},
   assignment:{mode:'round-robin', team:['Emma Clarke','James Webb','Sofia Reyes','Tom Bates']},
   matchCount:18, lastMatchAt:'2025-04-16'},
];
const ASSIGN_RULES_RR_INDEX = {};

const TICKET_TEMPLATES = [
  {id:'TT-001', name:'Password reset request',         category:'Account',   priority:'normal', subject:'Password reset for [customer ID]',        body:'Customer is unable to log in after attempting a password reset. Please verify identity, unlock the account if necessary, and confirm the reset email has been delivered.'},
  {id:'TT-002', name:'Refund — duplicate charge',      category:'Billing',   priority:'high',   subject:'Duplicate charge — refund requested',     body:'Customer reports being charged twice for the same transaction. Verify in the payments system, raise a refund for the duplicate amount, and confirm via email when processed.'},
  {id:'TT-003', name:'GDPR data erasure request',      category:'GDPR',      priority:'high',   subject:'Article 17 erasure request from [customer]', body:'Formal GDPR Article 17 erasure request received. Acknowledge within 24h, run the erasure workflow, and confirm completion in writing within the statutory 30-day window.'},
  {id:'TT-004', name:'Mobile app — performance issue', category:'Technical', priority:'normal', subject:'Mobile app slow on [device]',             body:'Customer reports the mobile app is unusably slow. Capture device model, OS version, and app build. Cross-reference against known performance regressions; escalate to mobile team if not on a patched build.'},
  {id:'TT-005', name:'Feature request',                category:'Feature',   priority:'low',    subject:'Feature request: [short description]',    body:'Customer suggested a new feature. Capture the use case, expected behaviour, and any business impact. Add to the product backlog and acknowledge the customer with an expected review timeframe.'},
];

const CHANNELS = [
  {id:'CH-001', name:'Support inbox',          type:'email',   address:'support@maestrodesk.com',     status:'active',   defaultCategory:'all',       defaultAgent:'',                 volume30d:142, signature:'— Maestro Desk Support'},
  {id:'CH-002', name:'Billing inbox',          type:'email',   address:'billing@maestrodesk.com',     status:'active',   defaultCategory:'Billing',   defaultAgent:'Sofia Reyes',      volume30d:38,  signature:'— Maestro Desk Billing'},
  {id:'CH-003', name:'Public help portal',     type:'webform', address:'maestrodesk.com/help/contact',status:'active',   defaultCategory:'all',       defaultAgent:'',                 volume30d:64,  signature:''},
  {id:'CH-004', name:'In-app chat widget',     type:'chat',    address:'widget://embed',              status:'active',   defaultCategory:'Technical', defaultAgent:'James Webb',       volume30d:212, signature:'Hi! Maestro Desk live chat — how can we help?'},
  {id:'CH-005', name:'Partner API integration',type:'api',     address:'/api/v1/tickets',             status:'inactive', defaultCategory:'all',       defaultAgent:'',                 volume30d:0,   signature:''},
];

// Synthetic inbox of incoming emails awaiting triage. Real-world this would
// be polled from each email channel's IMAP/API; for the demo it's seeded so
// the agent has realistic content to convert into tickets.
const INBOX = [
  {id:'EM-001', channelId:'CH-001', from:'Sarah Mitchell', fromEmail:'sarah.m@acme.com',
   subject:'Card keeps getting declined at checkout',
   body:'Hi, I\'ve tried three different cards and the checkout flow keeps failing on the final step. The page just spins for a while and then says "Something went wrong". I\'m on Chrome on a Mac. Order total was £148. Could you help?\n\nThanks,\nSarah',
   receivedAt:'2025-04-17 09:14', status:'new'},
  {id:'EM-002', channelId:'CH-002', from:'James Reed', fromEmail:'james.r@globex.io',
   subject:'March invoice missing',
   body:'Hi billing,\n\nI can\'t find the March 2025 invoice in my account. I need it for our finance team\'s month-end close. Can you resend it as a PDF?\n\nReference: GLO-2025-03\n\nJames Reed\nGlobex Finance',
   receivedAt:'2025-04-17 10:22', status:'new'},
  {id:'EM-003', channelId:'CH-001', from:'Carlos Diaz', fromEmail:'carlos@tyrell.com',
   subject:'iOS app crashing on login',
   body:'Since the last update the iOS app crashes the moment I tap "Sign in". Force-closing and reopening doesn\'t help. iPhone 14 Pro, iOS 17.4.\n\n— Carlos',
   receivedAt:'2025-04-17 11:03', status:'new'},
  {id:'EM-004', channelId:'CH-001', from:'Unknown sender', fromEmail:'newsletter@offers.example',
   subject:'🔥 Limited time — upgrade your account today!',
   body:'Click here for an exclusive offer just for you! Reply STOP to unsubscribe.',
   receivedAt:'2025-04-17 11:30', status:'new'},
  {id:'EM-005', channelId:'CH-002', from:'Priya Sharma', fromEmail:'priya@nakatomi.jp',
   subject:'Subscription renewal date question',
   body:'Hello,\n\nWhen exactly does my subscription auto-renew? I want to make sure my card on file is up to date before it processes.\n\nThanks,\nPriya',
   receivedAt:'2025-04-17 12:48', status:'new'},
  {id:'EM-006', channelId:'CH-001', from:'Tom Brewer', fromEmail:'tom@umbrella.co',
   subject:'Forgot to mention - export to XLSX too?',
   body:'Following up on my earlier export request — could the CSV export also be available as XLSX? Excel parses dates funny on the CSV.\n\n— Tom',
   receivedAt:'2025-04-17 13:11', status:'new'},
  {id:'EM-007', channelId:'CH-001', from:'Nina Kowalski', fromEmail:'nina@initech.com',
   subject:'Re: Initial setup help — thanks!',
   body:'Just wanted to say the setup walkthrough was excellent. Got everything configured in under 30 mins. Cheers.\n\nNina',
   receivedAt:'2025-04-17 14:02', status:'new'},
];

const ROLES_MATRIX = {
  'Admin':        {tickets:true,customers:true,reports:true,ai:true,workflows:true,tags:true,roles:true,gdpr:true},
  'Senior Agent': {tickets:true,customers:true,reports:true,ai:true,workflows:false,tags:true,roles:false,gdpr:true},
  'Read Only':    {tickets:false,customers:false,reports:true,ai:false,workflows:false,tags:false,roles:false,gdpr:false},
};

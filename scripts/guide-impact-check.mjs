const body = process.env.PR_BODY || '';
const choices = [
  '- [x] Guides updated or created',
  '- [x] No guide impact',
].filter(choice => body.toLowerCase().includes(choice.toLowerCase()));

if (choices.length !== 1) {
  console.error('Check exactly one Guide impact option in the pull request description.');
  process.exit(1);
}

console.log(`OK — ${choices[0].slice(6)}`);

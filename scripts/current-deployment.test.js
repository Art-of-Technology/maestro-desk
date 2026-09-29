import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { isCurrentDeployment } from './current-deployment.mjs';
import { waitForApi } from './api-deployment-check.mjs';
import { waitForFrontend } from './frontend-deployment-check.mjs';
const env = { GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'example/repo', GITHUB_TOKEN: 'test-token' };
const quiet = () => {};

test('only the current main commit is checked; local verification needs no GitHub access', async () => {
  let calls=0;
  const fetchImpl=async url => { calls++; expect(url).toBe('https://api.github.com/repos/example/repo/git/ref/heads/main'); return Response.json({object:{sha:env.GITHUB_SHA}}); };
  expect(await isCurrentDeployment({env,fetchImpl})).toBe(true);
  expect(await isCurrentDeployment({env:{},fetchImpl})).toBe(true); expect(calls).toBe(1);
  expect(await isCurrentDeployment({env,log:quiet,fetchImpl:async()=>Response.json({object:{sha:'b'.repeat(40)}})})).toBe(false);
});

test('GitHub failures and invalid context cannot silently skip verification', async () => {
  for(const fetchImpl of [async()=>new Response('',{status:403}), async()=>Response.json({}), async()=>{throw new Error('offline');}]) {
    await expect(isCurrentDeployment({env,fetchImpl})).rejects.toThrow();
  }
  await expect(isCurrentDeployment({env:{...env,GITHUB_TOKEN:''}})).rejects.toThrow('context');
  await expect(isCurrentDeployment({env:{...env,GITHUB_REF:'refs/heads/feature'}})).rejects.toThrow('context');
});

for(const kind of ['API','frontend']) {
  const wait = options => kind==='API'
    ? waitForApi('https://example.test','a'.repeat(64),options)
    : waitForFrontend('https://example.test',[{path:'index.html',content:Buffer.from('new')}],options);
  test(`${kind}: skip delayed old runs and stop when main advances, including during the final attempt`, async () => {
    let calls=0,checks=0;
    const verify=async()=>{calls++; if(kind==='API')throw new Error('old'); return ['old'];};
    const options={verify,log:quiet,pause:async()=>{},isCurrent:async()=>false};
    await wait(options); expect(calls).toBe(0);
    await wait({...options,isCurrent:async()=>++checks===1}); expect(calls).toBe(1);
    calls=0;checks=0;
    await wait({...options,attempts:1,isCurrent:async()=>++checks===1}); expect(calls).toBe(1); expect(checks).toBe(2);
    await expect(wait({...options,attempts:1,isCurrent:async()=>true})).rejects.toThrow('not verified');
    await expect(wait({...options,isCurrent:async()=>{throw new Error('GitHub unavailable');}})).rejects.toThrow('GitHub unavailable');
  });
}

test('workflow isolates concurrency by commit and gates all jobs on preflight',()=>{
  const yaml=readFileSync(new URL('../.github/workflows/post-deploy-healthcheck.yml',import.meta.url),'utf8');
  expect(yaml).toContain('group: post-deploy-healthcheck-${{ github.sha }}');
  expect(yaml.match(/needs: current/g)).toHaveLength(3);
  expect(yaml.match(/if: needs.current.outputs.current == 'true'/g)).toHaveLength(3);
  expect(yaml.match(/GITHUB_TOKEN: \$\{\{ github.token \}\}/g)).toHaveLength(3);
});

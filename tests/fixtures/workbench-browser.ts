import { createServer } from 'node:http'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { expect } from 'vitest'
import type { TaskPanelService } from '../../src/dsh-adapter/panel.js'
/** Final lazy-CJS artifact + exact native SlotCore/LayoutController + live Host Gateway. */
export async function workbenchBrowser(
  panel: TaskPanelService,
  cwd: string,
  invoke: (
    namespace: string,
    method: string,
    args: Record<string, unknown>,
  ) => Promise<unknown>,
  writeup: () => void,
) {
  const require = createRequire(import.meta.url),
    root = path.resolve('dist/validation')
  await mkdir(root, { recursive: true })
  const assets: Record<string, string> = {
    '/react.js': path.join(
      path.dirname(require.resolve('react/package.json')),
      'umd/react.development.js',
    ),
    '/react-dom.js': path.join(
      path.dirname(require.resolve('react-dom/package.json')),
      'umd/react-dom.development.js',
    ),
    '/plugin.js': path.resolve('lib/client.js'),
    '/slots.js': require.resolve('@deepseek-ai/dsh-client-ui-slots'),
  }
  const layoutSource = await readFile(
    require.resolve('@deepseek-ai/dsh-client-ui-layout/client'),
    'utf8',
  )
  // Exercise the SDK's real UiWorkspace directory methods, including its typed
  // DirectoryBrowseError, instead of a picker that always returns cwd.
  const workspaceSource = await readFile(require.resolve('@deepseek-ai/dsh-client-ui-workspace/client'), 'utf8')
  const methodsStart = workspaceSource.indexOf('async pickDirectory() {')
  const directoryMethods = workspaceSource.slice(methodsStart, workspaceSource.indexOf('watchNavigation() {', methodsStart))
  const errorStart = workspaceSource.indexOf('var DirectoryBrowseError = class')
  const directoryError = workspaceSource.slice(errorStart, workspaceSource.indexOf('\n\t\t};', errorStart) + 6)
  if (!directoryMethods.includes('async listDirectory(') || !directoryError.includes('this.rpcError = rpcError')) throw new Error('DSH directory API extraction drift')
  const layout = layoutSource
    .slice(
      layoutSource.indexOf('var LayoutController = class'),
      layoutSource.indexOf(
        '//#endregion',
        layoutSource.indexOf('var LayoutController = class'),
      ),
    )
    .replace('var LayoutController', 'export var LayoutController')
  if (!layout.includes('selectPanel(panelId)'))
    throw new Error('DSH LayoutController extraction drift')
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>html,body{height:100%;margin:0}body{font:14px system-ui,sans-serif;color:#1e2635;background:#fff}body.dark{background:#181b22;color:#e4e8ef;--dsw-alias-bg-base:#181b22;--dsw-alias-label-primary:#e4e8ef;--dsw-alias-label-secondary:#a1abba;--dsw-alias-border-l3:#a6afbf32}#shell{height:100%;display:grid;grid-template-columns:280px minmax(0,1fr)}#sidebar{border-right:1px solid #8392a538;padding:12px}#app{min-width:0;overflow:hidden}button{font:inherit;color:inherit}#chat{padding:32px}#chat textarea{width:80%;height:100px}#composer{margin-top:20px}</style><div id="shell"><aside id="sidebar"></aside><div id="app"></div></div><script src="/react.js"></script><script src="/react-dom.js"></script><script>window.__ModuleLoader__={load(entry){window.sapper=entry.factory(id=>id==='react'?React:id==='react-dom'?ReactDOM:{Fragment:React.Fragment,jsx:(type,props,key)=>React.createElement(type,{...props,key}),jsxs:(type,props,key)=>React.createElement(type,{...props,key})})}};</script><script src="/plugin.js"></script>
  <script type="module">import{SlotCore}from'/slots.js';import{LayoutController}from'/layout.js';import{DirectoryUi}from'/directory.js';
  const slots=new SlotCore();slots.register({name:'root',children:{'sidebar.panellist':{kind:'list',scope:'root'},main:{kind:'keyed',scope:'root'},'conversation.input.left':{kind:'list',scope:'root'},'conversation.chat.node':{kind:'keyed',scope:'session'},'settings.section':{kind:'list',scope:'root'},'plugins.item':{kind:'list',scope:'root'}}},()=>null);
  const app=ReactDOM.createRoot(document.getElementById('app')),sidebar=ReactDOM.createRoot(document.getElementById('sidebar'));let selected=null;window.retained=new Set();
  const render=()=>{sidebar.render(React.createElement(React.Fragment,null,...slots.entriesOfSlot('sidebar.panellist').map(e=>React.createElement('button',{key:e.options.id,onClick:()=>layout.selectPanel(e.options.id)},e.options.label))));const main=slots.entriesOfSlot('main').find(e=>e.options.key===selected);app.render(main?React.createElement(main.component):React.createElement('section',{id:'chat'},React.createElement('h2',null,'主会话'),React.createElement('textarea',{'aria-label':'主会话输入'}),React.createElement('div',{id:'composer'},...slots.entriesOfSlot('conversation.input.left').map(e=>React.createElement(e.component,{key:e.options.id})))))};
  const layout=new LayoutController({selectPanel(id){selected=id;render()}},id=>slots.entriesOfSlot('main').some(e=>e.options.key===id),{getSnapshot:()=>({}),subscribe:()=>()=>{}});window.layout=layout;
  const remote={$mount:async contribution=>{for(const d of contribution.descriptors){remote[d.namespace]??={};remote[d.namespace][d.method]=async(...values)=>{const args=Object.fromEntries(d.parameters.map((p,i)=>[p.wire,values[i]]));return fetch('/rpc/'+d.namespace+'/'+d.method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)}).then(r=>r.json())}}return()=>{}}};
  const value={status:'ready',writable:true,value:{enabled:true},base:{},user:{},revision:0};const scope={getSnapshot:()=>value,subscribe:()=>()=>{},set:async()=>true,mutate:async()=>true};
  const directoryRpc=async(method,args)=>fetch('/rpc/directoryPicker/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(args)}).then(r=>r.json());
  const directoryUi=new DirectoryUi({pick:()=>directoryRpc('pick',{}),list:(path)=>directoryRpc('list',{path}),createDirectory:(path,name)=>directoryRpc('createDirectory',{path,name})});directoryUi.openSession=id=>{window.opened=id;layout.selectPanel(null)};
  const ctx={remote,layout,uiWorkspace:directoryUi,sessions:{retain(id){window.retained.add(id);return{ready:Promise.resolve(),release(){window.retained.delete(id)}}}},inject:(_services,setup)=>setup(ctx),uiConversation:{events:{register:()=>()=>{}}},configForms:{get:()=>scope,whileServed:(ids,setup)=>setup(new Set(ids))},effect:setup=>setup(),slots:{inject:(_name,setup)=>setup(),register:(options,component)=>slots.register(options,component)}};
  sapper.apply(ctx);render();window.ready=true;
  </script></html>`
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/directory.js') {
        res.setHeader('content-type', 'text/javascript')
        res.end(directoryError + '\nexport class DirectoryUi { constructor(directoryPicker){this.directoryPicker=directoryPicker}\n' + directoryMethods + '}')
        return
      }
      if (assets[req.url!]) {
        res.setHeader('content-type', 'text/javascript')
        res.end(await readFile(assets[req.url!]!))
        return
      }
      if (req.url === '/layout.js') {
        res.setHeader('content-type', 'text/javascript')
        res.end(layout)
        return
      }
      if (req.method === 'POST' && req.url?.startsWith('/rpc/')) {
        let body = ''
        for await (const chunk of req) body += chunk
        const [, , namespace, method] = req.url.split('/')
        res.setHeader('content-type', 'application/json')
        try {
          res.end(
            JSON.stringify({
              ok: true,
              value: await invoke(namespace!, method!, JSON.parse(body)),
            }),
          )
        } catch (e) {
          res.end(
            JSON.stringify({
              ok: false,
              error: { message: (e as Error).message, code: (e as {code?: string}).code, details: (e as {details?: unknown}).details },
            }),
          )
        }
        return
      }
      res.setHeader('content-type', 'text/html;charset=utf-8')
      res.end(html)
    } catch (e) {
      res.statusCode = 500
      res.end(String(e))
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const browser = await chromium.launch({ headless: true }),
    errors: string[] = []
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 920 },
    })
    page.setDefaultTimeout(10000)
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(
      'http://127.0.0.1:' +
        (server.address() as import('node:net').AddressInfo).port,
    )
    await page
      .getByRole('button', { name: 'Sapper 比赛工作台', exact: true })
      .click()
    await page.getByRole('button', { name: '＋ 新建题目' }).click()
    await page.getByLabel('比赛根目录', { exact: true }).fill(cwd)
    await page.getByRole('button', { name: '选择文件夹' }).click()
    await page.getByRole('region', { name: '选择比赛根目录' }).waitFor()
    await page.getByRole('button', { name: '使用此目录' }).click()
    const title = '中文长题目 · 验证自动工作区、主会话和任务详情的可读性'
    await page.getByLabel('题名', { exact: true }).fill(title)
    await page
      .getByLabel('任务目标', { exact: true })
      .fill('检查当前文件夹；记录真实证据。'.repeat(16))
    await page.getByRole('button', { name: '创建并开始' }).click()
    await page.getByLabel('主会话输入').fill('输入框可编辑，任务在后台继续')
    await page.getByRole('button', { name: '打开 Sapper 比赛工作台' }).click()
    await page.getByRole('button').filter({ hasText: title }).click()
    await expect
      .poll(
        async () =>
          (await panel.overview()).challenges.find((c) => c.title === title)
            ?.job?.state,
        { timeout: 15000 },
      )
      .toBe('completed')
    const challenge = (await panel.overview()).challenges.find(
      (c) => c.title === title,
    )!
    await panel.briefs.whenIdle(challenge.sessionId)
    const {createTask}=await import('../../src/store/tasks.js')
    const {GraphStore}=await import('../../src/store/graph.js')
    const base=path.join(challenge.cwd,'.sapper')
    for(let i=0;i<32;i++)await createTask(base,challenge.cwd,'历史界面测试题目 '+i+' · '+title,challenge.sessionId,{guard:()=>{}})
    const selected=new GraphStore(path.join(base,'tasks',challenge.taskId),challenge.cwd)
    const seed=await selected.addIntent({title:'长中文依赖节点，用于验证标题换行、图拖动及完整节点详情',description:'浏览器大图只读测试节点',from:['f001']},challenge.sessionId)
    const graph=await selected.read();graph.project.counters.intent=330
    await writeFile(path.join(selected.root,'project.json'),JSON.stringify(graph.project))
    await Promise.all(Array.from({length:329},(_,i)=>{const id='i'+String(i+2).padStart(3,'0');return writeFile(path.join(selected.root,'intents',id+'.json'),JSON.stringify({...seed,id,title:seed.title+' '+id}))}))
    // UI-only synthetic observations reproduce repeater's note/vuln candidates;
    // neither contains or records a flag, and viewing them must remain read-only.
    const historyRun = await selected.readRun('r001')
    historyRun.outcomes = ['note', 'vuln'].map((kind, i) => ({
      intent_id: i ? 'i002' : seed.id, state: 'pending-verification' as const, verify_attempts: 0,
      candidate: { title: kind === 'note' ? 'repeater 附件清点' : 'repeater 漏洞分析', description: 'ELF64; Canary found; NX enabled; Partial RELRO', kind: kind as 'note' | 'vuln', evidence: [], explorer_session: 'browser-fixture' },
    }))
    await selected.saveRun(historyRun)
    await page.getByText('候选结果 · 尚未复核', { exact: true }).waitFor()
    await page.getByText('漏洞候选 · 尚未复核', { exact: true }).waitFor()
    expect(await page.getByText('候选 flag，尚未复核', { exact: true }).count()).toBe(0)
    await expect.poll(async()=>await page.locator('.sp-task').count(),{timeout:12000}).toBeGreaterThan(30)
    await page.getByLabel('搜索题目').fill('不存在的题目');await page.getByText('没有匹配的题目。选择比赛目录即可新建。').waitFor();await page.getByLabel('搜索题目').fill('')
    const before = Object.keys(panel.workbench.snapshot().jobs).length
    for (const theme of ['light', 'dark'])
      for (const width of [1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 920 })
        await page.emulateMedia({ colorScheme: theme as 'light' | 'dark' })
        await page.evaluate(
          (dark) => document.body.classList.toggle('dark', dark),
          theme === 'dark',
        )
        await page.getByRole('tab', { name: '概览', exact: true }).click()
        expect(
          await page
            .locator('.sp-workbench')
            .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
        ).toBe(true)
        await page.screenshot({
          path: path.join(root, `workbench-${theme}-${width}.png`),
        })
      }
    await page.getByRole('tab', { name: '事实图', exact: true }).click()
    await page.getByRole('img', { name: '事实与意图关系图' }).waitFor()
    await page.getByText('另有 31 个节点未纳入本视图；完整数据保留在本题事实图文件中。').waitFor()
    const bounds=await page.locator('.sp-graph-window').boundingBox();if(bounds){await page.mouse.move(bounds.x+5,bounds.y+5);await page.mouse.down();await page.mouse.move(bounds.x+70,bounds.y+35);await page.mouse.up()}
    await page.getByRole('button', { name: '图放大' }).click()
    await page.getByRole('button', { name: '适应视口' }).click()
    await page.locator('g[data-node]').first().focus();await page.keyboard.press('Enter');await page.getByText('浏览器大图只读测试节点',{exact:true}).waitFor()
    await page.screenshot({ path: path.join(root, 'workbench-graph.png') })
    await page.getByRole('tab', { name: '证据', exact: true }).click()
    await page.getByRole('tab', { name: '执行记录', exact: true }).click()
    await page.getByRole('tab', { name: '概览', exact: true }).click()
    expect(Object.keys(panel.workbench.snapshot().jobs)).toHaveLength(before)
    writeup()
    await writeFile(
      path.join(challenge.cwd, 'fixture.txt'),
      'VERIFIED-LOCAL-7C42\n',
    )
    await page.getByRole('button', { name: '编写 WP', exact: true }).click()
    await expect
      .poll(async () => Object.keys(panel.workbench.snapshot().jobs).length)
      .toBe(before + 1)
    await panel.whenIdle(challenge.cwd)
    expect(await readFile(path.join(challenge.cwd, 'WP.md'), 'utf8')).toContain(
      'Reproduction:',
    )
    const wpTask = (await panel.state(challenge.sessionId)).active
    await expect.poll(() => page.getByLabel('查看阶段').inputValue()).toBe(wpTask)
    await page.getByRole('tab', { name: '文件', exact: true }).click()
    await page.getByRole('button', { name: 'WP.md ↗', exact: true }).click()
    await page.locator('.sp-file').waitFor()
    await page.screenshot({ path: path.join(root, 'workbench-wp.png') })
    expect(errors).toEqual([])
    await writeFile(
      path.join(root, 'workbench-browser.json'),
      JSON.stringify(
        {
          errors,
          viewports: [1024, 1280, 1440],
          themes: ['light', 'dark'],
          challenge,
          slots: 'actual DSH SlotCore',
          layout: 'actual DSH LayoutController',
          host: 'actual Gateway, WorkspaceRegistry, SessionController, AgentLoop, Domain/JSONL',
        },
        null,
        2,
      ),
    )
  } finally {
    await browser.close()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
const compiled = await build({entryPoints:['extensions/studio-workstation/src/workflow-resource-preview.ts'],bundle:true,platform:'node',format:'cjs',external:['vscode'],write:false});
function fixture(columns=[1], active=1){
 const created=[],commands=[];let groups=columns;
 const vscode={ViewColumn:{Active:-1,Beside:-2},window:{tabGroups:{get all(){return groups.map(viewColumn=>({viewColumn}));},get activeTabGroup(){return {viewColumn:active};}},createWebviewPanel(type,title,options){
   const listeners=new Set();const target=options.viewColumn===-2?Math.max(...groups)+1:options.viewColumn;if(!groups.includes(target))groups.push(target);
   const panel={viewColumn:target,title,reveals:[],onDidDispose(listener){listeners.add(listener);return{dispose:()=>listeners.delete(listener)};},reveal(column,preserveFocus){this.viewColumn=column;this.reveals.push({column,preserveFocus});},dispose(){for(const listener of [...listeners])listener();}};
   created.push({type,options,panel});return panel;
 }},commands:{executeCommand(...args){commands.push(args);}}};
 const module={exports:{}};runInNewContext(compiled.outputFiles[0].text,{module,exports:module.exports,require:()=>vscode});
 const previews=new module.exports.SideResourcePreview();return{previews,created,commands,setGroups(next){groups=next;}};
}
test('the second card action creates one editor split and reuses its preview tab',()=>{
 const f=fixture();const first=f.previews.open('First',1);assert.equal(f.created.length,1);assert.equal(f.created[0].options.viewColumn,-2);assert.equal(first.viewColumn,2);
 const next=f.previews.open('Second',1);assert.equal(next,first);assert.equal(next.title,'Second');assert.equal(f.created.length,1);assert.equal(next.reveals[0].column,2);assert.equal(next.reveals[0].preserveFocus,false);assert.deepEqual(f.commands,[]);
});
test('existing split groups are reused on either side without adding another group',()=>{
 for(const [columns,source,target]of [[[1,2],1,2],[[1,2],2,1],[[1,2,3],1,2],[[1,2,3],2,3]]){
   const f=fixture([...columns],source);assert.equal(f.previews.open('Resource',source).viewColumn,target);assert.equal(f.created[0].options.viewColumn,target);
 }
});
test('the conversation column is preserved even when another editor is active',()=>{
 const f=fixture([1,2],2);assert.equal(f.previews.open('Resource',1).viewColumn,2);
});
test('closed previews reopen in the existing split and disposed owners close their preview',()=>{
 const f=fixture([1,2]);const first=f.previews.open('First',1);first.dispose();const second=f.previews.open('Second',1);assert.notEqual(second,first);assert.equal(f.created.length,2);assert.equal(second.viewColumn,2);
 f.previews.dispose();const third=f.previews.open('Third',1);assert.notEqual(third,second);
});
test('a preview moved into the conversation group is moved back to a different existing group',()=>{
 const f=fixture([1,2]);const panel=f.previews.open('First',1);panel.viewColumn=1;f.previews.open('Second',1);assert.equal(panel.reveals.at(-1).column,2);
});
test('sidebar cards keep the same side preview when it becomes the active editor',()=>{
 const f=fixture([1,2],2);const panel=f.previews.open('First');const column=panel.viewColumn;f.previews.open('Second');assert.equal(panel.reveals.at(-1).column,column);
});

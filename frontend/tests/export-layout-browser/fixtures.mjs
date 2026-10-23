import { projectNotebookContent } from '../../src/shared/notebookContent.ts'
import { createExportDocument, collectExportFontText } from '../../src/shared/exportDocument.ts'
import { createExportReview } from '../../src/shared/exportReviewPolicy.ts'
import { preflightImages } from '../../src/shared/exportImageResources.ts'
import { prepareBrowserExportFonts } from '../../src/print/exportFontBrowser.ts'
const id='01900000-0000-7000-8000-000000000001',missing='01900000-0000-7000-8000-000000000002'
const text=(value,marks)=>({type:'text',text:value,...(marks?{marks:marks.map(type=>({type}))}:{})}),p=(...children)=>({type:'paragraph',content:children})
export async function fixedSource(mode,signal){
 const canvas=document.createElement('canvas');canvas.width=240;canvas.height=1200
 const c=canvas.getContext('2d');c.fillStyle='#f4efe4';c.fillRect(0,0,240,1200);c.strokeStyle='#557563';c.lineWidth=4;c.strokeRect(3,3,234,1194);c.fillStyle='#2e2c28';c.font='18px sans-serif';c.fillText('TOP 01',15,35);c.fillText('BOTTOM 99',15,1180)
 for(let y=80;y<1150;y+=80){c.strokeStyle='#cfc8bb';c.lineWidth=1;c.beginPath();c.moveTo(12,y);c.lineTo(228,y);c.stroke()}
 const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('fixed PNG unavailable')
 const definitions=[
  {title:'雨后记事，沿着纸页继续阅读',nodes:[p(text('山色入窗，夜雨初歇。'.repeat(60))),{type:'blockquote',content:[p(text('一编青简，半生浮沉。'.repeat(15),['italic']))]},
   {type:'orderedList',attrs:{start:3},content:[{type:'listItem',content:[p(text('第三项，序号与正文保持。'.repeat(65),['bold'])),{type:'bulletList',content:[{type:'listItem',content:[p(text('内层列表，空　字 与 emoji 🌿。'.repeat(8)))]}]}]},{type:'listItem',content:[p(text('第四项，不能重置为第一项。'))]}]},p(text('段末标记 BODY_END_01'))]},
  {title:'代码与没有空格的长词',nodes:[{type:'codeBlock',content:[text('const diary = "local-first";\n'+Array.from({length:27},(_,i)=>`line_${i+1}: `+'long_code_'.repeat(13)).join('\n')+'\nCODE_END_02')]},p(text('long_word_'.repeat(190)+'WORD_END_02')),p(text('文字 '),text('强调不会在续页时丢失。'.repeat(20),['bold','italic']),text(' 文字末尾 🌿'))]},
  {title:'长图完整保留，诊断与占位不省略',nodes:[p(text('这张固定校准图的上下标记和四边应完整可见。')),{type:'image',attrs:{src:`local://media/${id}`,alt:'固定长图，完整边框',title:'图一：等比缩小，不裁边'}},p(text('图后继续正文，不把图注或文本裁掉。')),{type:'image',attrs:{src:`local://media/${missing}`,alt:'固定缺图说明',title:'缺图占位'}},p(text('BODY_END_03'))]},
 ]
 const entries=definitions.map((e,i)=>({id:`layout-${i+1}`,entryDate:`2026-10-${21+i}`,sortOrder:0,title:e.title,mood:'🌿',weather:'晴',tags:[{id:'tag',name:'公开样张',color:null}],updatedAt:'fixed',content:projectNotebookContent({schemaVersion:1,doc:{type:'doc',content:e.nodes}})}))
 const snapshot={entries,media:[{id,blob,thumbnailOnly:false},{id:missing,blob:null,thumbnailOnly:false}],diagnostics:[{code:'IMAGE_MISSING',entryId:'layout-3',resourceId:missing}],completeOutputReady:false}
 const review=createExportReview(snapshot,[]),images=await preflightImages([{id,blob}],{signal}),book=createExportDocument({snapshot,images,review,degradedConfirmed:true,contentMode:'degraded',completeOutputReady:false})
 const font=await prepareBrowserExportFonts(collectExportFontText(book),mode,{signal,assertCurrent:async()=>{if(signal.aborted)throw Object.assign(Error('CANCELLED'),{code:'CANCELLED'})}})
 let invalid=false;const listeners=new Set(),value=Object.freeze({document:book,font,changed:false,completeOutputReady:false})
 return {async read(){if(invalid||signal.aborted)throw Object.assign(Error('CANCELLED'),{code:'CANCELLED'});return value},async readImages(){return images.items},subscribeReleased(fn){listeners.add(fn);return()=>listeners.delete(fn)},release(){if(invalid)return;invalid=true;for(const fn of [...listeners])fn();listeners.clear();font.release()},font,scope:'固定公开材料；程序确认缺图降级；非正式账号/快照入口'}
}

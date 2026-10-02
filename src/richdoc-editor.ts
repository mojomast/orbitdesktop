import {createEditor,$getSelection,$isRangeSelection,$createParagraphNode,FORMAT_TEXT_COMMAND,UNDO_COMMAND,REDO_COMMAND,PASTE_COMMAND,COMMAND_PRIORITY_HIGH,TextNode,type TextFormatType} from 'lexical';
import {registerRichText,HeadingNode,QuoteNode,$createHeadingNode,$createQuoteNode} from '@lexical/rich-text';
import {registerHistory,createEmptyHistoryState} from '@lexical/history';
import {ListNode,ListItemNode,registerList,INSERT_UNORDERED_LIST_COMMAND,INSERT_ORDERED_LIST_COMMAND} from '@lexical/list';
import {LinkNode,AutoLinkNode} from '@lexical/link';
import {CodeNode,CodeHighlightNode,$createCodeNode} from '@lexical/code';
import {$setBlocksType} from '@lexical/selection';
import {$convertFromMarkdownString,$convertToMarkdownString,registerMarkdownShortcuts,TRANSFORMERS} from '@lexical/markdown';
import {validateDocumentData} from '../contracts/documents-v1.mjs';
import type {MountedDocumentEditor} from './document-store-client';
import './richdoc-editor.css';
const nodes=[HeadingNode,QuoteNode,ListNode,ListItemNode,LinkNode,AutoLinkNode,CodeNode,CodeHighlightNode];
export function markdownDocument(text:string){
  // HTML is not a supported import format; reject rather than imply rendering it.
  if(/<\/?[a-z][^>]*>/i.test(text))throw Error('HTML is not supported in Markdown imports.');
  const editor=createEditor({namespace:'OrbitMarkdownImport',nodes,onError(error){throw error;}});
  editor.update(()=>{$convertFromMarkdownString(text,TRANSFORMERS);},{discrete:true});
  const data={kind:'richtext' as const,format:'lexical' as const,content:JSON.stringify(editor.getEditorState().toJSON())};validateDocumentData(data);return data;
}
export async function mountEditor(host:HTMLElement,content:string,onChange:(content:string)=>void):Promise<MountedDocumentEditor> {
  validateDocumentData({kind:'richtext',format:'lexical',content});
  const shell=document.createElement('div');shell.className='richdoc-editor';
  const toolbar=document.createElement('div');toolbar.className='richdoc-toolbar';toolbar.setAttribute('role','toolbar');toolbar.setAttribute('aria-label','Rich document formatting');
  const root=document.createElement('div');root.className='richdoc-content';root.contentEditable='true';root.setAttribute('role','textbox');root.setAttribute('aria-label','Rich document content');root.setAttribute('aria-multiline','true');root.spellcheck=true;
  const errors=document.createElement('p');errors.className='richdoc-error';errors.setAttribute('role','alert');
  shell.append(toolbar,errors,root);host.replaceChildren(shell);
  const editor=createEditor({namespace:'OrbitRichDocument',nodes:[HeadingNode,QuoteNode,ListNode,ListItemNode,LinkNode,AutoLinkNode,CodeNode,CodeHighlightNode],theme:{paragraph:'richdoc-paragraph',quote:'richdoc-quote',heading:{h1:'richdoc-h1',h2:'richdoc-h2',h3:'richdoc-h3'},text:{bold:'richdoc-bold',italic:'richdoc-italic',underline:'richdoc-underline',strikethrough:'richdoc-strike',code:'richdoc-inline-code'},code:'richdoc-code'},onError(error){errors.textContent=error.message;}});
  function action(label:string,fn:()=>void) {const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('mousedown',e=>e.preventDefault());b.addEventListener('click',()=>{fn();editor.focus();});toolbar.append(b);}
  for(const [label,format] of [['Bold','bold'],['Italic','italic'],['Underline','underline'],['Inline code','code']] as [string,TextFormatType][])action(label,()=>editor.dispatchCommand(FORMAT_TEXT_COMMAND,format));
  action('Paragraph',()=>editor.update(()=>{$setBlocksType($getSelection(),()=>$createParagraphNode());}));
  action('Heading',()=>editor.update(()=>{$setBlocksType($getSelection(),()=>$createHeadingNode('h2'));}));
  action('Quote',()=>editor.update(()=>{$setBlocksType($getSelection(),()=>$createQuoteNode());}));
  action('Code block',()=>editor.update(()=>{$setBlocksType($getSelection(),()=>$createCodeNode());}));
  action('Bullet list',()=>editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND,undefined));
  action('Numbered list',()=>editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND,undefined));
  action('Undo',()=>editor.dispatchCommand(UNDO_COMMAND,undefined));action('Redo',()=>editor.dispatchCommand(REDO_COMMAND,undefined));
  editor.setRootElement(root);
  editor.setEditorState(editor.parseEditorState(content),{tag:'orbit-load'});
  const cleanups=[registerRichText(editor),registerList(editor),registerHistory(editor,createEmptyHistoryState(),300,Date.now,undefined,100),registerMarkdownShortcuts(editor,TRANSFORMERS),editor.registerNodeTransform(TextNode,node=>{if(node.getStyle())node.setStyle('');}),
    // Plain-text paste avoids importing arbitrary HTML/style nodes into the
    // finite persisted document schema. Markdown shortcuts remain available.
    editor.registerCommand(PASTE_COMMAND,event=>{if(!(event instanceof ClipboardEvent)||!event.clipboardData)return false;const text=event.clipboardData.getData('text/plain');event.preventDefault();const selection=$getSelection();if($isRangeSelection(selection))selection.insertRawText(text);return true;},COMMAND_PRIORITY_HIGH),
    editor.registerUpdateListener(({editorState,dirtyElements,dirtyLeaves,tags})=>{if(tags.has('orbit-load')||(!dirtyElements.size&&!dirtyLeaves.size))return;onChange(JSON.stringify(editorState.toJSON()));})];
  return {getContent(){return JSON.stringify(editor.getEditorState().toJSON());},setContent(next){validateDocumentData({kind:'richtext',format:'lexical',content:next});editor.setEditorState(editor.parseEditorState(next),{tag:'orbit-load'});},applySnapshot(next){validateDocumentData({kind:'richtext',format:'lexical',content:next});editor.setEditorState(editor.parseEditorState(next),{tag:'history-push'});},selectedContent(){return editor.getEditorState().read(()=>{const selection=$getSelection();return $isRangeSelection(selection)?selection.getTextContent():'';});},setReadOnly(readonly){editor.setEditable(!readonly);toolbar.querySelectorAll('button').forEach(b=>b.disabled=readonly);},exportMarkdown(){return editor.getEditorState().read(()=>$convertToMarkdownString(TRANSFORMERS));},dispose(){cleanups.reverse().forEach(fn=>fn());editor.setRootElement(null);shell.remove();}};
}

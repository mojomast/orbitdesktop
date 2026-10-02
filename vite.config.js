import { defineConfig } from "vite";
import {readdir,readFile,lstat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {technologyNotices} from './scripts/technology-notices.mjs';
import {canvasFontPolicyPlugin,isPublishedCanvasFont} from './server/documents-canvas-assets.mjs';
// Preserve the pinned library's exact font filenames; these assets are reached
// only by a mounted canvas. No CDN/font fetch or copy into generated plugins.
const canvasFonts={name:'orbit-canvas-fonts',async generateBundle(){
  const root=fileURLToPath(new URL('./node_modules/@excalidraw/excalidraw/',import.meta.url));
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  if(pkg.version!=='0.18.1')throw Error('Excalidraw asset version mismatch');
  const files=[];
  async function visit(relative){
    const dir=path.join(root,'dist/prod/fonts',relative);
    for(const entry of await readdir(dir,{withFileTypes:true})){
      if(entry.isSymbolicLink())throw Error('Canvas asset symlink');
      const name=path.posix.join(relative,entry.name);
      if(entry.isDirectory())await visit(name);
      else if(entry.isFile()&&isPublishedCanvasFont(name))files.push(name);
    }
  }
  await visit('');
  for(const name of files){const file=path.join(root,'dist/prod/fonts',name);if((await lstat(file)).nlink!==1)throw Error('Canvas asset hardlink');this.emitFile({type:'asset',fileName:`vendor/excalidraw-0.18.1/fonts/${name}`,source:await readFile(file)});}
  this.emitFile({type:'asset',fileName:'vendor/excalidraw-0.18.1/fonts-manifest.json',source:JSON.stringify(files)});
}};
export default defineConfig({
  plugins:[canvasFontPolicyPlugin(),canvasFonts,technologyNotices(fileURLToPath(new URL('./',import.meta.url)))],
  server: {
    host: "0.0.0.0",
    port: 4173,
    allowedHosts: ["terminal.local"],
    headers: { "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" },
    proxy: {
      "/api": { target: "http://127.0.0.1:4318", ws: true, changeOrigin: true },
      "/vendor": { target: "http://127.0.0.1:4318", changeOrigin: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 850,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ["three"],
          terminal: ["@xterm/xterm", "@xterm/addon-fit"],
        },
      },
    },
  },
});

import fs from "node:fs";
import path from "node:path";
import { hash } from "./knowledge-chunker.mjs";
export const MODEL = {
  id: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  dtype: "q8",
  dimensions: 384,
};
export const MODEL_FILES = [
  [
    "config.json",
    650,
    "7135149f7cffa1a573466c6e4d8423ed73b62fd2332c575bf738a0d033f70df7",
  ],
  [
    "tokenizer.json",
    711661,
    "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
  ],
  [
    "tokenizer_config.json",
    366,
    "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
  ],
  [
    "special_tokens_map.json",
    125,
    "b6d346be366a7d1d48332dbc9fdf3bf8960b5d879522b7799ddba59e76237ee3",
  ],
  [
    "vocab.txt",
    231508,
    "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
  ],
  [
    "onnx/model_quantized.onnx",
    22972370,
    "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
  ],
];
export function assertPrivatePath(file, directory = false) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    stat.mode & 0o077
  )
    throw Object.assign(Error("unavailable"), { code: "unavailable" });
  return stat;
}
export function verifyModel(dir) {
  try {
    assertPrivatePath(dir, true);
    const manifest = path.join(dir, "model.json");
    if (assertPrivatePath(manifest).size > 8192) return false;
    const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (
      JSON.stringify(value) !== JSON.stringify({ ...MODEL, files: MODEL_FILES })
    )
      return false;
    assertPrivatePath(path.join(dir, "onnx"), true);
    for (const [name, size, sha] of MODEL_FILES) {
      const file = path.join(dir, name);
      if (
        assertPrivatePath(file).size !== size ||
        hash(fs.readFileSync(file)) !== sha
      )
        return false;
    }
    return true;
  } catch {
    return false;
  }
}

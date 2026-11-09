// TASK-879: fonts are imported with `with { type: "file" }` so `bun build --compile` embeds them; the import is the file's path.
// pdfkit's own typings are not reachable through its `exports` map under this tsconfig; the export code is covered by tests, so it is typed `any` here
// (adding @types/pdfkit would change package.json beyond the two pinned deps).
declare module "pdfkit";
declare module "*.ttf" {
  const path: string;
  export default path;
}

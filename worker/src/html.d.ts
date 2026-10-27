// static/*.html is bundled as a string by the Text rule in wrangler.jsonc.
declare module "*.html" {
  const html: string;
  export default html;
}

import { randomBytes } from 'node:crypto';

export function imPairQuery(query) {
  const [view, ...duplicates] = query.getAll('im');
  if (duplicates.length) return '';
  const result = new URLSearchParams();
  const conversations = query.getAll('conversation_id'), users = query.getAll('user_id');
  if (view === 'chat' && conversations.length + users.length === 1) {
    const [id] = conversations.length ? conversations : users;
    if (!id || id.length > (conversations.length ? 256 : 100) || /[\u0000-\u001f\u007f]/u.test(id)) return '';
    result.set('im', view);
    result.set(conversations.length ? 'conversation_id' : 'user_id', id);
  } else if (['add-contact', 'create-group'].includes(view) && !conversations.length && !users.length) {
    result.set('im', view);
  } else return '';
  // Carry only the IM target, not arbitrary redirect paths, credentials or workbench parameters.
  return '?' + result;
}

export function pairPage(req, res, imQuery) {
  const zh = /^zh(?:[-;,]|$)/i.test(req.headers['accept-language'] ?? '');
  const s = zh ? { title: '配对 SteamHarness Studio', code: '配对码', submit: '确认配对', waiting: '正在配对…',
    hint: '在宿主机的 Studio 设置 → 远程访问中生成配对码。', warning: '此设备将获得完整访问权限，包括文件和终端。',
    invalid: '配对码错误、已使用或已过期。请在宿主机上生成新码。', limit: '尝试次数过多，请稍后再试。', failed: '无法配对，请检查连接后重试。' }
    : { title: 'Pair with SteamHarness Studio', code: 'Pairing code', submit: 'Confirm pairing', waiting: 'Pairing…',
      hint: 'On the host, generate a code in Studio Settings → Remote Access.', warning: 'This device will get full access, including files and the terminal.',
      invalid: 'The code is incorrect, used, or expired. Generate a new code on the host.', limit: 'Too many attempts. Try again shortly.', failed: 'Pairing failed. Check your connection and try again.' };
  const nonce = randomBytes(16).toString('base64url');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Language': zh ? 'zh-CN' : 'en',
    'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'` });
  res.end(`<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${s.title}</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--surface:#fff;--text:#181c25;--muted:#545e6e;--line:#ced4de;--accent:#155abd;--error:#a51c28}
@media(prefers-color-scheme:dark){:root{--surface:#181b23;--text:#f0f3fa;--muted:#adb7c7;--line:#4b5464;--accent:#1562c9;--error:#ff9da5}}
*,*::before,*::after{box-sizing:border-box}body{margin:0;padding:24px;display:grid;min-height:100dvh;place-items:center;background:var(--surface);color:var(--text);font:1rem/1.5 system-ui,sans-serif}
main{width:min(100%,26rem)}h1{font-size:1.45rem;line-height:1.25;margin:0 0 .75rem}p{margin:0 0 1rem;color:var(--muted)}label{display:block;font-weight:600;margin-bottom:.4rem}
input,button{font:inherit;width:100%;min-height:44px;border-radius:6px;padding:.5rem .75rem}input{border:1px solid var(--line);background:transparent;color:inherit;font-family:ui-monospace,monospace;text-transform:uppercase}
button{border:0;background:var(--accent);color:white;margin-top:.9rem;font-weight:600;cursor:pointer}button:disabled{opacity:.65;cursor:wait}input:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
small{display:block;color:var(--muted);margin-top:.75rem}#status{margin:.75rem 0 0;min-height:1.5em;color:var(--error)}
</style><main><h1>${s.title}</h1><p>${s.hint}</p>
<form><label for="code">${s.code}</label><input id="code" name="code" required maxlength="32" placeholder="XXXX-XXXX-XXXX" autocapitalize="characters" spellcheck="false" autocomplete="off"><button>${s.submit}</button><small>${s.warning}</small><p id="status" role="status"></p></form></main>
<script nonce="${nonce}">
const form=document.querySelector('form'), code=document.querySelector('#code'), button=document.querySelector('button'), status=document.querySelector('#status'), text=${JSON.stringify(s)};
const prefill=()=>{if(!location.hash)return;const value=new URLSearchParams(location.hash.slice(1)).get('code');if(value!==null)code.value=value.slice(0,32);history.replaceState(null,'',location.pathname+${JSON.stringify(imQuery)});};
prefill();addEventListener('hashchange',prefill);
form.addEventListener('submit',async event=>{event.preventDefault();button.disabled=true;button.textContent=text.waiting;status.textContent='';try{
const response=await fetch('/_studio/web/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code.value})});
if(response.ok){location.replace(${JSON.stringify('/' + imQuery)});return}status.textContent=response.status===429?text.limit:response.status===401?text.invalid:text.failed;
}catch{status.textContent=text.failed}button.disabled=false;button.textContent=text.submit;code.focus();code.select()});
</script></html>`);
}

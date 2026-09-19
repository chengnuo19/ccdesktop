/** 选项页：保存连接密钥。存进 chrome.storage 后 background 会自动重连。 */

const AUTH_KEY = 'xfbToken';

const input = document.getElementById('token');
const saveBtn = document.getElementById('save');
const status = document.getElementById('status');

function show(text, tone) {
  status.textContent = text;
  if (tone) status.dataset.tone = tone;
  else delete status.dataset.tone;
}

chrome.storage.local.get(AUTH_KEY).then((stored) => {
  input.value = stored[AUTH_KEY] ?? '';
});

saveBtn.addEventListener('click', async () => {
  const token = input.value.trim();
  if (!token) {
    show('密钥不能为空', 'err');
    return;
  }
  await chrome.storage.local.set({ [AUTH_KEY]: token });
  show('已保存，正在重新连接…', 'ok');
  setTimeout(() => show(''), 2600);
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveBtn.click();
});

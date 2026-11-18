const appPath = new URL('.', import.meta.url).pathname;
const form = document.querySelector('#login-form');
const password = document.querySelector('#password');
const submit = document.querySelector('#login-submit');
const error = document.querySelector('#login-error');

document.querySelector('#password-toggle').addEventListener('click', event => {
  const button = event.currentTarget;
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
});
document.querySelector('#help-toggle').addEventListener('click', event => {
  const help = document.querySelector('#login-help');
  help.hidden = !help.hidden;
  event.currentTarget.setAttribute('aria-expanded', String(!help.hidden));
});

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (submit.disabled || !form.reportValidity()) return;
  submit.disabled = true;
  submit.querySelector('span').textContent = '正在登录…';
  error.hidden = true;
  try {
    const next = new URLSearchParams(location.search).get('next') || appPath;
    const response = await fetch(`${appPath}auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: form.elements.username.value.trim(), password: password.value, remember: form.elements.remember.checked, next: `${next}${location.hash}` })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '暂时无法登录，请稍后再试。');
    password.value = '';
    location.replace(result.redirect);
  } catch (failure) {
    error.textContent = failure instanceof TypeError ? '暂时无法连接工作台，请检查网络后重试。' : failure.message;
    error.hidden = false;
    submit.disabled = false;
    submit.querySelector('span').textContent = '进入工作台';
  }
});

import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

test.beforeEach(async ({ context }) => {
  if (!process.env.AIRCAST_LIVE_SIGNALING) await context.addInitScript({ path: fileURLToPath(new URL('./mock-peer.js', import.meta.url)) });
  await context.addInitScript(() => {
    let hidden = false;
    Object.defineProperty(document, 'hidden', { get: () => hidden });
    document.addEventListener('fixture-hide', () => { hidden = true; document.dispatchEvent(new Event('visibilitychange')); });
  });
});

const code = () => 'T' + randomBytes(6).toString('hex').toUpperCase();
const video = '#output.has-media';
async function startCamera(page, room, slot, address) {
  await page.goto(address || '/?mode=sender&room=' + room + '&cam=' + slot);
  await page.locator('#enableCamera').click();
  await page.locator('#phoneLive').click();
}

async function copiedObsUrl(studio, slot = '') {
  await studio.locator('#openOutputManager').click();
  await studio.locator('#outputChoice').selectOption(slot);
  await studio.locator('#outputForm [type=submit]').click();
  await expect(studio.locator('#outputUrl')).toHaveValue(/(?:#|&)watch=1\./);
  const url = await studio.locator('#outputUrl').inputValue();
  await studio.locator('#outputManager [data-close]').click();
  return url;
}

test('legacy and current camera outputs play with Studio closed and reconnect', async ({ context }) => {
  const room = code();
  const output = await context.newPage();
  await output.goto('/?obs=' + room + '&c=1&slate=off&bg=transparent');
  const phone = await context.newPage();
  await startCamera(phone, room, 'CAM1');
  await expect(output.locator(video)).toBeVisible({ timeout:15000 });
  await expect(output.locator('#output')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(output.locator('.dissolve-layer').first()).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  const legacy = await context.newPage();
  await legacy.goto('/?room=' + room + '&obs=direct&cam=CAM1');
  await expect(legacy.locator(video)).toBeVisible({ timeout:15000 });
  await expect(legacy.locator('#output')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
  await phone.locator('#phoneHideCamera').click();
  await expect(phone.locator('#phoneStatus')).toContainText('Camera hidden');
  await expect(phone.locator('#phoneView.has-media')).toBeVisible();
  await expect(legacy.locator('#outputIdle')).toBeVisible();
  await phone.locator('#phoneHideCamera').click();
  await expect(legacy.locator(video)).toBeVisible();
  await phone.locator('#phoneLive').click();
  await expect(output.locator(video)).toHaveCount(0);
  await expect(output.locator('#outputPair')).toBeHidden();
  await expect(output.locator('#outputIdle')).toBeHidden();
  await expect(legacy.locator('#outputIdle')).toBeVisible();
  await phone.locator('#phoneLive').click();
  await expect(output.locator(video)).toBeVisible();
  await output.keyboard.press('d');
  await expect(output.locator('.connection-card')).toContainText('Direct camera');
  await phone.locator('#phoneSettings').click();
  await phone.locator('#phoneDiagnostics').click();
  await expect(phone.locator('.connection-card')).toContainText('Direct camera uplink');
  await phone.getByRole('button', { name:'Close diagnostics' }).click();
  await phone.evaluate(() => document.dispatchEvent(new Event('fixture-hide')));
  await expect(legacy.locator('#outputPair')).toBeVisible();
});

test('Program switches to Multiview on the same URL and new rooms start empty', async ({ context }) => {
  const first = code();
  const studio = await context.newPage();
  await studio.goto('/?room=' + first);
  await expect(studio.locator('#studioSignal')).toContainText('Signaling ready');
  await studio.locator('#quickUSB').click();
  await studio.locator('#usbBody [type=submit]').click();
  await expect(studio.locator('#usbPreview.has-media')).toBeVisible();
  await studio.locator('#sourceDialog [data-close]').click();
  const grid = await context.newPage();
  await grid.goto('/?obs=' + first);
  const programUrl = grid.url();
  await expect(grid.locator(video)).toBeVisible();
  await studio.locator('#programMultiview').click();
  await expect(studio.locator('#programGrid [data-slot="CAM1"].has-media')).toBeVisible();
  await expect(grid.locator('.output-grid iframe').first()).toBeVisible();
  await expect(grid.frameLocator('iframe[title="CAM 1"]').locator(video)).toBeVisible({ timeout:15000 });
  const tile = await grid.locator('iframe[title="CAM 1"]').elementHandle();
  await studio.locator('#multiviewColumns').selectOption('3');
  await expect(studio.locator('#programGrid')).toHaveCSS('--columns', '3');
  await expect(grid.locator('#output > .output-grid')).toHaveCSS('--columns', '3');
  expect(await tile.evaluate((element) => element.isConnected)).toBe(true);
  await expect(grid).toHaveURL(programUrl);
  await studio.locator('#programMultiview').click();
  await expect(studio.locator('#programGrid')).toBeHidden();
  await expect(grid.locator('#output > .output-grid')).toHaveCount(0);
  await expect(grid.locator(video)).toBeVisible();
  if (process.env.AIRCAST_SCREENSHOTS) {
    await studio.locator('#openOutputManager').click();
    await studio.locator('#outputClean').check();
    await studio.locator('#outputManager').screenshot({ path:'docs/images/output-manager.png' });
    await studio.locator('#outputManager [data-close]').click();
  }
  await studio.locator('#roomButton').click();
  expect(new URL(studio.url()).searchParams.has('room')).toBe(false);
  await studio.locator('#createRoom').click();
  if (process.env.AIRCAST_SCREENSHOTS) await studio.locator('.room-welcome').screenshot({ path:'docs/images/room-home.png' });
  await studio.locator('#createRoomForm [type=submit]').click();
  await expect(studio).toHaveURL(/room=[A-Z0-9]{16}/);
  await expect(studio.locator('#cameraCount')).toHaveText('0 connected');
  await studio.locator('#quickPair').click();
  await expect(studio.locator('#pairURL')).toHaveValue(/mode=sender/);
  const openPhone = await context.newPage();
  await openPhone.goto(await studio.locator('#pairURL').inputValue());
  await expect(openPhone.locator('#enableCamera')).toBeVisible();
  const join = await context.newPage();
  await join.goto('/?join=' + first);
  await expect(join.locator('#joinValue')).toHaveValue(first);
  await join.locator('#joinSlot').selectOption('CAM20');
  await join.locator('#joinForm [type=submit]').click();
  await expect(join).toHaveURL(/mode=sender.*cam=CAM20/);
});

test('stored encrypted rooms ask the phone for a password while OBS displays and receives without one', async ({ context }) => {
  const studio = await context.newPage();
  const requests = [];
  context.on('request', (request) => { if (new URL(request.url()).pathname.endsWith('/api/rooms')) requests.push(request); });
  await studio.goto('/');
  await studio.locator('#createRoom').click();
  await studio.locator('#createPassword').fill('a4BC');
  await studio.locator('#roomExpiry').selectOption('1');
  await studio.locator('#createRoomForm [type=submit]').click();
  await expect(studio).toHaveURL(/sealed=1$/);
  await expect(studio.locator('#studioSignal')).toContainText('Signaling ready');
  await studio.locator('#quickPair').click();
  const field = studio.locator('#pairURL');
  await expect(field).toHaveValue(/mode=sender/);
  const cameraUrl = await field.inputValue();
  expect(new URL(cameraUrl).searchParams.get('cam')).toBe('CAM1');
  expect(cameraUrl).not.toMatch(/a4BC|ticket=/);
  await studio.locator('#sourceDialog [data-close]').click();
  const obs = await context.newPage();
  await obs.goto(await copiedObsUrl(studio));
  await expect(obs.locator('#outputPair')).toBeVisible();
  await expect(obs.locator('#joinPassword')).toBeHidden();
  const direct = await context.newPage();
  const directUrl = await copiedObsUrl(studio, 'CAM1');
  await direct.goto(directUrl);
  await expect(direct.locator('#outputPair')).toBeVisible();
  await expect(direct.locator('#outputPairCamera')).toHaveText('CAM 1');
  await expect(direct.locator('#joinPassword')).toBeHidden();
  const unlock = async (page, password = 'a4BC') => {
    await page.locator('#joinPassword').fill(password);
    await page.locator('#roomPasswordForm [type=submit]').click();
  };
  const phone = await context.newPage();
  await phone.goto(cameraUrl);
  await expect(phone.locator('#joinTitle')).toHaveText('Enter room password');
  await unlock(phone, 'wrong-password');
  await expect(phone.locator('#joinFeedback')).toHaveText('Incorrect password or corrupted room data.');
  await unlock(phone);
  await phone.locator('#enableCamera').click();
  await phone.locator('#phoneLive').click();
  await expect(studio.locator('#sourceList .source-row').first()).toContainText('Live', { timeout:18000 });
  await expect(obs.locator(video)).toBeVisible({ timeout:18000 });
  await studio.locator('#programMultiview').click();
  await expect(studio.locator('#programGrid [data-slot="CAM1"].has-media')).toBeVisible();
  await expect(obs.frameLocator('iframe[title="CAM 1"]').locator(video)).toBeVisible({ timeout:15000 });
  await studio.locator('#programMultiview').click();
  await expect(obs.locator('#output > .output-grid')).toHaveCount(0);
  await expect(direct.locator(video)).toBeVisible({ timeout:18000 });
  await studio.goto('about:blank');
  await expect(obs.locator(video)).toHaveCount(0, { timeout:15000 });
  await expect(direct.locator(video)).toBeVisible({ timeout:15000 });
  await direct.keyboard.press('d');
  await expect(direct.locator('.connection-card')).toContainText('Direct camera', { timeout:15000 });
  await phone.goto('about:blank');
  await expect(direct.locator('#outputPair')).toBeVisible();
  const posts = requests.filter((request) => request.method() === 'POST');
  expect(posts).toHaveLength(1);
  expect(posts[0].postData()).toMatch(/^1\.\d+\.[\w-]+\.[\w-]+\.[\w-]+$/);
  expect(posts[0].postData()).not.toContain('a4BC');
});

test('portable encrypted links work without storage and reload requests the password', async ({ context }) => {
  await context.route('**/api/rooms?*', (route) => route.fulfill({ status: 501 }));
  const studio = await context.newPage();
  await studio.goto('/');
  await studio.locator('#createRoom').click();
  await studio.locator('#createPassword').fill('portable broadcast phrase');
  await studio.locator('#createRoomForm [type=submit]').click();
  await expect(studio).toHaveURL(/sealed=1#room=1\./);
  await studio.locator('#quickPair').click();
  const joinUrl = await studio.locator('#pairURL').inputValue();
  expect(joinUrl).toMatch(/sealed=1#room=1\./);
  expect(joinUrl).not.toContain('portable');
  const phone = await context.newPage();
  await phone.goto(joinUrl);
  await expect(phone.locator('#joinTitle')).toHaveText('Enter room password');
  await phone.locator('#joinPassword').fill('portable broadcast phrase');
  await phone.locator('#roomPasswordForm [type=submit]').click();
  await phone.locator('#enableCamera').click();
  await phone.locator('#phoneLive').click();
  await expect(studio.locator('#sourceList .source-row').first()).toContainText('Live', { timeout:18000 });
  await studio.locator('#sourceDialog [data-close]').click();
  const programUrl = await copiedObsUrl(studio);
  const address = new URL(programUrl);
  expect(address.searchParams.get('obs')).toBeTruthy();
  expect(address.searchParams.get('sealed')).toBe('1');
  expect(new URLSearchParams(address.hash.slice(1)).get('room')).toMatch(/^1\./);
  const viewer = await context.newPage();
  await viewer.goto(programUrl);
  await expect(viewer.locator('#joinPassword')).toBeHidden();
  await expect(viewer.locator(video)).toBeVisible({ timeout:15000 });
  await studio.locator('#programMultiview').click();
  await expect(viewer.frameLocator('iframe[title="CAM 1"]').locator(video)).toBeVisible({ timeout:15000 });
  await expect(studio.locator('#programGrid [data-slot="CAM1"].has-media')).toBeVisible();
  await studio.reload();
  await expect(studio.locator('#joinTitle')).toHaveText('Enter room password');
  await studio.locator('#joinPassword').fill('portable broadcast phrase');
  await studio.locator('#roomPasswordForm [type=submit]').click();
  await expect(studio.locator('#studioSignal')).toContainText('Signaling ready');
});

test('the protected direct OBS QR contains only the phone join link', async ({ context, request }) => {
  await context.route('**/api/rooms?*', (route) => route.fulfill({ status: 501 }));
  const studio = await context.newPage();
  await studio.goto('/');
  await studio.locator('#createRoom').click();
  await studio.locator('#createPassword').fill('an encrypted camera room');
  await studio.locator('#createRoomForm [type=submit]').click();
  const direct = new URL(await copiedObsUrl(studio, 'CAM2'));
  const origin = 'https://aircast.test';
  await context.route(origin + '/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const response = await request.get(path === '/' ? '/index.html' : path);
    if (path === '/aircast-qr.min.js') {
      const hook = 'const makeCode = QRCode.prototype.makeCode; QRCode.prototype.makeCode = function (value) { window.lastQR = value; return makeCode.call(this, value); };';
      await route.fulfill({ response, body: (await response.text()) + '\n' + hook });
    } else await route.fulfill({ response });
  });
  const obs = await context.newPage();
  await obs.goto(origin + direct.pathname + direct.search + direct.hash);
  await expect(obs.locator('#outputPairQR')).toBeVisible();
  await expect(obs.locator('#joinPassword')).toBeHidden();
  await expect.poll(() => obs.evaluate(() => window.lastQR)).toContain('cam=CAM2');
  const qr = await obs.evaluate(() => window.lastQR);
  expect(qr).toContain('#room=1.');
  expect(qr).not.toContain('watch=');
  expect(qr).not.toContain('an encrypted camera room');
  const phone = await context.newPage();
  await phone.goto(qr);
  await expect(phone.locator('#joinPassword')).toBeVisible();
  await phone.locator('#joinPassword').fill('an encrypted camera room');
  await phone.locator('#roomPasswordForm [type=submit]').click();
  await expect(phone.locator('#phoneDestination')).toHaveText('CAM 2');
});

test('custom IDs reserve one URL, hide Studio from guests, and show the live countdown', async ({ context, browser }) => {
  const id = code();
  const studio = await context.newPage();
  await studio.goto('/');
  await studio.locator('#createRoom').click();
  await studio.locator('#createRoomId').fill(id.toLowerCase());
  await studio.locator('#roomExpiry').selectOption('1');
  await studio.locator('#createRoomForm [type=submit]').click();
  await expect(studio.locator('#roomCode')).toHaveText(id);
  const countdown = studio.locator('#roomCountdown');
  await expect(countdown).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
  const shown = await countdown.textContent();
  await expect(countdown).not.toHaveText(shown);
  const guest = await browser.newContext({ baseURL: new URL(studio.url()).origin });
  try {
    const page = await guest.newPage();
    await page.goto(studio.url());
    await expect(page.locator('#joinFeedback')).toContainText('browser that created this room');
    await expect(page.locator('#studio')).toBeHidden();
    await page.goto('/?room=' + id);
    await expect(page.locator('#studio')).toBeHidden();
    await expect(page.locator('#joinFeedback')).toContainText('browser that created this room');
    await page.goto('/');
    await page.locator('#createRoom').click();
    await page.locator('#createRoomId').fill(id);
    await page.locator('#createRoomForm [type=submit]').click();
    await expect(page.locator('#joinFeedback')).toContainText('Room ID is already in use');
    await expect(page.locator('#createRoomId')).toHaveValue(id);
  } finally { await guest.close(); }

  await studio.locator('#quickPair').click();
  const cameraUrl = await studio.locator('#pairURL').inputValue();
  const phone = await context.newPage();
  await phone.goto(cameraUrl);
  await expect(phone.locator('#phoneDestination')).toHaveText('CAM 1');
  const dialog = studio.locator('#sourceDialog');
  for (const viewport of [{ width: 980, height: 750 }, { width: 390, height: 620 }]) {
    await studio.setViewportSize(viewport);
    const initial = await dialog.boundingBox();
    for (const tab of ['USB camera', 'MJPEG', 'Phone']) {
      await studio.getByRole('button', { name: tab, exact: true }).click();
      const bounds = await dialog.boundingBox();
      expect(bounds.width).toBe(initial.width);
      expect(bounds.height).toBe(initial.height);
    }
  }
});

test('custom IDs stay unique without room storage', async ({ context }) => {
  await context.route('**/api/rooms?*', (route) => route.fulfill({ status: 501 }));
  const studio = await context.newPage();
  await studio.goto('/');
  await studio.locator('#createRoom').click();
  await studio.locator('#createRoomId').fill('TESTSTAGE');
  await studio.locator('#createRoomForm [type=submit]').click();
  await expect(studio.locator('#roomCode')).toHaveText(/^TESTSTAGE-[A-Z2-9]{16}$/);
  const room = await studio.locator('#roomCode').textContent();
  const obs = await context.newPage();
  await obs.goto('/?obs=' + room + '&c=1');
  const phone = await context.newPage();
  await startCamera(phone, room, 'CAM1');
  await expect(obs.locator(video)).toBeVisible({ timeout: 15000 });
  await studio.goto('/');
  await studio.locator('#createRoom').click();
  await studio.locator('#createRoomId').fill('teststage');
  await studio.locator('#createRoomForm [type=submit]').click();
  await expect(studio.locator('#joinFeedback')).toContainText('Room ID is already in use');
});

test('PWA retains the whole app shell after going offline', async ({ context }) => {
  const page = await context.newPage();
  await page.goto('/?room=' + code());
  await expect(page.locator('#studioSignal')).toContainText('Signaling ready');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page.locator('#roomButton')).toBeVisible();
  await expect(page.locator('#roomButton')).toHaveCSS('border-top-left-radius', '7px');
  await page.locator('#openOutputManager').click();
  await expect(page.locator('#outputManager')).toBeVisible();
});

test('Program keeps its previous frame until a staged cut is ready', async ({ context }) => {
  const room = code();
  const studio = await context.newPage();
  const obs = await context.newPage();
  await studio.goto('/?room=' + room);
  await expect(studio.locator('#studioSignal')).toContainText('Signaling ready');
  await obs.goto('/?obs=' + room);
  await startCamera(await context.newPage(),room,'CAM1');
  await expect(obs.locator(video)).toBeVisible({ timeout:16000 });
  await startCamera(await context.newPage(),room,'CAM2');
  await expect(studio.locator('#sourceList .source-row').nth(1)).toContainText('Live');
  await obs.evaluate(() => {
    const original = ProgramReceiver.prototype.present;
    window.cutProbe = { holding: true, before: document.querySelector('#output video').srcObject };
    ProgramReceiver.prototype.present = function (route) {
      if (cutProbe.holding && this.active && this.active !== route && route.stream?.getVideoTracks().some((track) => !track.muted)) {
        cutProbe.resume = () => original.call(this, route);
        return;
      }
      return original.call(this, route);
    };
  });
  await studio.locator('#tiles .tile').nth(1).locator('.tile-select').click();
  await expect.poll(() => obs.evaluate(() => typeof cutProbe.resume), { timeout:10000 }).toBe('function');
  await expect(obs.locator(video)).toBeVisible();
  expect(await obs.evaluate(() => document.querySelector('#output video').srcObject === cutProbe.before)).toBe(true);
  await obs.evaluate(() => { cutProbe.holding = false; cutProbe.resume(); });
  await expect.poll(() => obs.evaluate(() => document.querySelector('#output video').srcObject !== cutProbe.before)).toBe(true);
  await expect(obs.locator(video)).toBeVisible();
});

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

test('public rooms keep separate settings and Multiview loads Studio-owned slots', async ({ context }) => {
  const first = code();
  const studio = await context.newPage();
  await studio.goto('/?room=' + first);
  await expect(studio.locator('#studioSignal')).toContainText('Signaling ready');
  await studio.locator('#quickUSB').click();
  await studio.locator('#usbBody [type=submit]').click();
  await expect(studio.locator('#usbPreview.has-media')).toBeVisible();
  await studio.locator('#sourceDialog [data-close]').click();
  const grid = await context.newPage();
  await grid.goto('/?obs=' + first + '&view=multiview&slots=1,10');
  await expect(grid.locator('.output-grid iframe')).toHaveCount(2);
  await expect(grid.frameLocator('iframe[title="CAM 1"]').locator(video)).toBeVisible({ timeout:15000 });
  if (process.env.AIRCAST_SCREENSHOTS) {
    await studio.locator('#openOutputManager').click();
    await studio.locator('#outputChoice').selectOption('multiview');
    await studio.locator('#outputClean').check();
    await studio.locator('#outputManager').screenshot({ path:'docs/images/output-manager.png' });
    await studio.locator('#outputManager [data-close]').click();
  }
  await studio.locator('#roomButton').click();
  await studio.locator('#createRoom').click();
  await expect(studio).toHaveURL(/room=[A-Z0-9]{16}$/);
  await expect(studio.locator('#cameraCount')).toHaveText('0 connected');
  await expect(grid.frameLocator('iframe[title="CAM 1"]').locator(video)).toHaveCount(0);
  const join = await context.newPage();
  await join.goto('/?join=' + first);
  await expect(join.locator('#joinValue')).toHaveValue(first);
  await join.locator('#joinSlot').selectOption('CAM20');
  await join.locator('#joinForm [type=submit]').click();
  await expect(join).toHaveURL(/mode=sender.*cam=CAM20/);
});

test('private grant authorizes Studio and direct paths, then revocation ends direct streaming', async ({ context }) => {
  const studio = await context.newPage();
  await studio.goto('/');
  await studio.locator('#roomButton').click();
  await studio.locator('#createPrivateRoom').click();
  await expect(studio).toHaveURL(/private=1/);
  await expect(studio.locator('#studioSignal')).toContainText('Signaling ready');
  const room = new URL(studio.url()).searchParams.get('room');
  await studio.locator('#roomButton').click();
  if (process.env.AIRCAST_SCREENSHOTS) await studio.locator('#roomDialog').screenshot({ path:'docs/images/private-room.png' });
  await studio.locator('#inviteCamera').click();
  const field = studio.locator('#roomInviteLink');
  await expect(field).toHaveValue(/mode=sender.+#ticket=/);
  const cameraUrl = await field.inputValue();
  await studio.locator('#inviteViewer').click();
  await expect(field).toHaveValue(/obs=.+#ticket=/);
  const viewerUrl = await field.inputValue();
  const phone = await context.newPage();
  await startCamera(phone, room, 'CAM1', cameraUrl);
  const obs = await context.newPage();
  await obs.goto(viewerUrl);
  await expect(studio.locator('#sourceList .source-row').first()).toContainText('Live', { timeout:18000 });
  await expect(obs.locator(video)).toBeVisible({ timeout:18000 });
  const unknown = await context.newPage();
  await unknown.goto('/?obs=' + room + '&c=1&private=1');
  await expect(unknown.locator('#outputPairTitle')).toHaveText('Private output unavailable');
  await expect(unknown.locator(video)).toHaveCount(0);
  const direct = await context.newPage();
  const cameraOutput = new URL(viewerUrl);
  cameraOutput.searchParams.set('c','1');
  await direct.goto(cameraOutput.href);
  await expect(direct.locator(video)).toBeVisible({ timeout:18000 });
  const studioUrl = studio.url();
  await studio.goto('about:blank');
  await expect(obs.locator(video)).toHaveCount(0, { timeout:15000 });
  await expect(direct.locator(video)).toBeVisible({ timeout:15000 });
  await direct.keyboard.press('d');
  await expect(direct.locator('.connection-card')).toContainText('Direct camera', { timeout:15000 });
  await studio.goto(studioUrl);
  await expect(studio.locator('#studioSignal')).toContainText('Signaling ready', { timeout:15000 });
  await studio.locator('#roomButton').click();
  await studio.locator('#roomInvites .invite-row').filter({ hasText:'Contributor' }).getByRole('button', { name:'Revoke' }).click();
  await expect(direct.locator(video)).toHaveCount(0, { timeout:20000 });
  await phone.goto(cameraUrl);
  await phone.reload();
  await expect(phone.locator('#joinTitle')).toHaveText('Private room unavailable');
  await expect(phone.locator('#joinFeedback')).toContainText('does not allow');
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

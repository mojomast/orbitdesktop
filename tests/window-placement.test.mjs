import assert from 'node:assert/strict';
import { test } from 'node:test';
import { placeWindow } from '../src/windows.ts';

const frame = () => ({ x: 450, y: 310, width: 640, height: 420, z: 3 });

test('unsized host displays persisted coordinates without zeroing them', () => {
  const element = { style: {} };
  const monitor = { frame: frame() };
  placeWindow(element, monitor, { clientWidth: 0, clientHeight: 0 }, 0);
  assert.equal(monitor.frame.x, 450);
  assert.equal(monitor.frame.y, 310);
  assert.deepEqual(element.style, { left: '450px', top: '310px', width: '640px', height: '420px', zIndex: '3', transform: 'none' });
});

test('small viewport clamps display coordinates only', () => {
  const element = { style: {} };
  const monitor = { frame: frame() };
  placeWindow(element, monitor, { clientWidth: 200, clientHeight: 100 }, 0);
  assert.equal(element.style.left, '80px');
  assert.equal(element.style.top, '52px');
  assert.equal(monitor.frame.x, 450);
  assert.equal(monitor.frame.y, 310);
});

test('passive placement preserves an existing frame for sized and unsized hosts', () => {
  const monitor = { frame: frame() };
  const original = structuredClone(monitor.frame);
  for (const host of [{ clientWidth: 200, clientHeight: 100 }, { clientWidth: 0, clientHeight: 0 }, { clientWidth: 0, clientHeight: 100 }]) {
    placeWindow({ style: {} }, monitor, host, 1);
    assert.deepEqual(monitor.frame, original);
  }
});

test('missing frame is initialized once and survives unsized placement', () => {
  const monitor = {};
  const element = { style: {} };
  const host = { clientWidth: 0, clientHeight: 0 };
  placeWindow(element, monitor, host, 1);
  assert.deepEqual(monitor.frame, { x: 88, y: 60, width: 320, height: 220, z: 2 });
  placeWindow(element, monitor, host, 0);
  assert.deepEqual(monitor.frame, { x: 88, y: 60, width: 320, height: 220, z: 2 });
  assert.equal(element.style.left, '88px');
  assert.equal(element.style.top, '60px');
});

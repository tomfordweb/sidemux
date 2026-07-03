import { describe, expect, test } from 'vitest';
import {
  isKnownShell,
  isValidLayout,
  isValidPaneSize,
  loadConfig,
  shellDialectFromCommand,
  subdivideDirection,
} from '../../src/config.js';

describe('loadConfig', () => {
  test('defaults with empty env', () => {
    expect(loadConfig({})).toEqual({
      sessionName: 'smux',
      managedOnly: false,
      shell: null,
      socketName: null,
      maxOutputBytes: 8192,
      reusePanes: true,
      paneShell: null,
      layout: 'bottom',
      paneSize: '30%',
      paneHeader: true,
      closeOnSuccess: false,
    });
  });

  test('reads all SIDEMUX_* vars', () => {
    const config = loadConfig({
      SIDEMUX_SESSION: 'work',
      SIDEMUX_MANAGED_ONLY: '1',
      SIDEMUX_SHELL: 'fish',
      SIDEMUX_TMUX_SOCKET: 'mysock',
      SIDEMUX_MAX_OUTPUT_BYTES: '4096',
      SIDEMUX_REUSE_PANES: '0',
      SIDEMUX_PANE_SHELL: 'sh',
      SIDEMUX_LAYOUT: 'right',
      SIDEMUX_PANE_SIZE: '40%',
      SIDEMUX_PANE_HEADER: '0',
      SIDEMUX_CLOSE_ON_SUCCESS: '1',
    });
    expect(config).toEqual({
      sessionName: 'work',
      managedOnly: true,
      shell: 'fish',
      socketName: 'mysock',
      maxOutputBytes: 4096,
      reusePanes: false,
      paneShell: 'sh',
      layout: 'right',
      paneSize: '40%',
      paneHeader: false,
      closeOnSuccess: true,
    });
  });

  test('closeOnSuccess only when SIDEMUX_CLOSE_ON_SUCCESS is exactly "1"', () => {
    expect(loadConfig({}).closeOnSuccess).toBe(false);
    expect(loadConfig({ SIDEMUX_CLOSE_ON_SUCCESS: '0' }).closeOnSuccess).toBe(false);
    expect(loadConfig({ SIDEMUX_CLOSE_ON_SUCCESS: 'true' }).closeOnSuccess).toBe(false);
    expect(loadConfig({ SIDEMUX_CLOSE_ON_SUCCESS: '1' }).closeOnSuccess).toBe(true);
  });

  test('layout accepts each direction and defaults invalid to bottom', () => {
    expect(loadConfig({ SIDEMUX_LAYOUT: 'left' }).layout).toBe('left');
    expect(loadConfig({ SIDEMUX_LAYOUT: 'TOP' }).layout).toBe('top');
    expect(loadConfig({ SIDEMUX_LAYOUT: 'sideways' }).layout).toBe('bottom');
  });

  test('pane size accepts percent or cell count, rejects junk', () => {
    expect(loadConfig({ SIDEMUX_PANE_SIZE: '50%' }).paneSize).toBe('50%');
    expect(loadConfig({ SIDEMUX_PANE_SIZE: '80' }).paneSize).toBe('80');
    expect(loadConfig({ SIDEMUX_PANE_SIZE: 'huge' }).paneSize).toBe('30%');
  });

  test('non-fish shell names map to posix dialect', () => {
    expect(loadConfig({ SIDEMUX_SHELL: 'zsh' }).shell).toBe('posix');
  });

  test('invalid max bytes falls back to default', () => {
    expect(loadConfig({ SIDEMUX_MAX_OUTPUT_BYTES: 'nope' }).maxOutputBytes).toBe(8192);
    expect(loadConfig({ SIDEMUX_MAX_OUTPUT_BYTES: '-5' }).maxOutputBytes).toBe(8192);
  });
});

describe('layout helpers', () => {
  test('subdivideDirection is perpendicular to the bar', () => {
    // horizontal bars (top/bottom) grow rightward
    expect(subdivideDirection('bottom')).toBe('right');
    expect(subdivideDirection('top')).toBe('right');
    // vertical bars (left/right) grow downward
    expect(subdivideDirection('left')).toBe('bottom');
    expect(subdivideDirection('right')).toBe('bottom');
  });

  test('isValidLayout accepts the four edges only', () => {
    expect(isValidLayout('bottom')).toBe(true);
    expect(isValidLayout('right')).toBe(true);
    expect(isValidLayout('sideways')).toBe(false);
    expect(isValidLayout('')).toBe(false);
  });

  test('isValidPaneSize accepts percent or cell count', () => {
    expect(isValidPaneSize('30%')).toBe(true);
    expect(isValidPaneSize('80')).toBe(true);
    expect(isValidPaneSize('huge')).toBe(false);
    expect(isValidPaneSize('30%%')).toBe(false);
  });
});

describe('shell detection', () => {
  test('recognizes posix shells including full paths', () => {
    expect(shellDialectFromCommand('bash')).toBe('posix');
    expect(shellDialectFromCommand('/usr/bin/zsh')).toBe('posix');
    expect(shellDialectFromCommand('sh')).toBe('posix');
  });

  test('recognizes fish', () => {
    expect(shellDialectFromCommand('fish')).toBe('fish');
    expect(shellDialectFromCommand('/opt/homebrew/bin/fish')).toBe('fish');
  });

  test('unknown commands are not shells', () => {
    expect(shellDialectFromCommand('node')).toBeNull();
    expect(isKnownShell('vim')).toBe(false);
    expect(isKnownShell('bash')).toBe(true);
  });
});

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRemoteAttachmentPath, resolveAttachmentPath } from './resolve-path'

const SOURCE_DIR = '/home/user/export'

describe('resolveAttachmentPath', () => {
  const cases: Array<{ name: string; sourceDir: string | null; input: string; expected: string | null }> = [
    { name: 'plain relative file', sourceDir: SOURCE_DIR, input: 'a.jpg', expected: '/home/user/export/a.jpg' },
    {
      name: 'nested relative file',
      sourceDir: SOURCE_DIR,
      input: 'images/a.jpg',
      expected: '/home/user/export/images/a.jpg',
    },
    {
      name: 'leading ./ is stripped',
      sourceDir: SOURCE_DIR,
      input: './images/a.jpg',
      expected: '/home/user/export/images/a.jpg',
    },
    {
      name: 'inner .. that stays inside',
      sourceDir: SOURCE_DIR,
      input: 'images/../voice/a.mp3',
      expected: '/home/user/export/voice/a.mp3',
    },
    { name: 'parent escape', sourceDir: SOURCE_DIR, input: '../secret.txt', expected: null },
    { name: 'deep parent escape', sourceDir: SOURCE_DIR, input: 'images/../../../etc/passwd', expected: null },
    { name: 'prefix-similar sibling directory', sourceDir: SOURCE_DIR, input: '../exportx/a.jpg', expected: null },
    { name: 'backslash parent escape', sourceDir: SOURCE_DIR, input: '..\\secret.txt', expected: null },
    {
      name: 'absolute path is returned unchanged',
      sourceDir: SOURCE_DIR,
      input: '/etc/passwd',
      expected: '/etc/passwd',
    },
    {
      name: 'http url is returned unchanged',
      sourceDir: SOURCE_DIR,
      input: 'https://cdn.example.com/a.jpg',
      expected: 'https://cdn.example.com/a.jpg',
    },
    { name: 'missing source dir rejects a relative path', sourceDir: null, input: 'a.jpg', expected: null },
    {
      name: 'missing source dir still allows an absolute path',
      sourceDir: null,
      input: '/media/a.jpg',
      expected: '/media/a.jpg',
    },
    { name: 'empty path', sourceDir: SOURCE_DIR, input: '', expected: null },
    { name: 'source dir root', sourceDir: '/', input: 'a.jpg', expected: '/a.jpg' },
    {
      name: 'trailing separator on source dir',
      sourceDir: '/home/user/export/',
      input: 'a.jpg',
      expected: '/home/user/export/a.jpg',
    },
    {
      name: 'windows source dir keeps backslashes',
      sourceDir: 'C:\\Users\\me\\export',
      input: 'images/a.jpg',
      expected: 'C:\\Users\\me\\export\\images\\a.jpg',
    },
    { name: 'windows parent escape', sourceDir: 'C:\\Users\\me\\export', input: '..\\..\\secret', expected: null },
  ]

  for (const testCase of cases) {
    it(testCase.name, () => {
      assert.equal(resolveAttachmentPath(testCase.sourceDir, testCase.input), testCase.expected)
    })
  }
})

describe('isRemoteAttachmentPath', () => {
  it('detects http(s) and other scheme URLs only', () => {
    assert.equal(isRemoteAttachmentPath('https://example.com/a.jpg'), true)
    assert.equal(isRemoteAttachmentPath('http://example.com/a.jpg'), true)
    assert.equal(isRemoteAttachmentPath('images/a.jpg'), false)
    assert.equal(isRemoteAttachmentPath('/home/user/a.jpg'), false)
    assert.equal(isRemoteAttachmentPath('C:\\a.jpg'), false)
  })
})

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { generateKeyPairSync, sign } from 'node:crypto';
import { loadWorkflow, workflowStep, extractMarkedSource } from './workflow-source.cjs';

const workflow = loadWorkflow('release-sparkle-app.yml');
const root = mkdtempSync(join(tmpdir(), 'sparkle-tools-'));
const modules = new Map();
for (const job of Object.values(workflow.jobs)) {
  for (const step of job.steps ?? []) {
    for (const match of (step.run ?? '').matchAll(/(?:#|\/\/) BEGIN ([\w.-]+\.(?:py|cjs))\n/g)) {
      const name = match[1];
      const marker = name.endsWith('.py') ? '#' : '//';
      const source = extractMarkedSource(step.run, `${marker} BEGIN ${name}\n`, `${marker} END ${name}`);
      if (modules.has(name)) assert.equal(source, modules.get(name), `${name} differs between production jobs`);
      modules.set(name, source);
      writeFileSync(join(root, name), source);
    }
  }
}
process.on('exit', () => rmSync(root, { recursive: true, force: true }));
function python(source, env = {}) {
  const result = spawnSync('python3', ['-c', source], { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result;
}

test('all extracted production Python tools compile', () => {
  python(`import py_compile\nfrom pathlib import Path\nfor p in Path('.').glob('*.py'): py_compile.compile(str(p), doraise=True)`);
});

test('macOS runner provides the older SDK required by the Swift runtime audit', { skip: process.platform !== 'darwin' }, () => {
  const result = python("from runtime import discover_sdks, choose_sdk\nchoose_sdk(discover_sdks(), '15.0')");
  console.log(result.stderr);
});

test('production input validator rejects path, layout, version, secret and checksum ambiguity', () => {
  const inputs = workflow.on?.workflow_call?.inputs ?? workflow.true.workflow_call.inputs;
  const base = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k.toUpperCase().replaceAll('-', '_'), String(v.default ?? '')]));
  Object.assign(base, { VERSION: '1.2.3', REPOSITORY_TYPE: 'openclaw', APP_NAME: 'Fixture', BUNDLE_IDENTIFIER: 'org.example.fixture', MINIMUM_SYSTEM_VERSION: '15.0', APP_BUILD_SCRIPT: 'scripts/build.sh', APP_ENTITLEMENTS: 'app.plist', SPARKLE_PUBLIC_KEY: Buffer.alloc(32, 1).toString('base64'), APPCAST_FEED_URL: 'https://example.test/feed.xml', DMG_BACKGROUND: 'assets/background.png', DMG_LAYOUT: JSON.stringify({ 'window-size': [720, 460], 'icon-size': 128, 'app-position': [180, 230], 'applications-position': [540, 230], 'volume-name': 'Fixture' }), GITHUB_OUTPUT: join(root, 'outputs') });
  const run = (patch) => spawnSync('python3', ['contract.py'], { cwd: root, env: { ...base, ...patch, PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(run({}).status, 0);
  for (const patch of [
    { APP_ENTITLEMENTS: '../unsafe' }, { APPCAST_PATH: '.' }, { APP_BUILD_SCRIPT: 'foo/../bad' },
    { CHECKSUM_FILENAME: 'Appcast.XML' }, { CHECKSUM_FILENAME: 'Fixture-1.2.3.app.zip' }, { CHECKSUM_FILENAME: 'hashes.' },
    { VERSION: '1.2.3-nightly.1' }, { VERSION: '01.2.3' }, { MINIMUM_SYSTEM_VERSION: '16.0' },
    { SPARKLE_VERSION: 'latest' }, { SPARKLE_PUBLIC_KEY: 'bad' }, { APPCAST_FEED_URL: 'http://example.test/feed.xml' },
    { CLI_BUILD_SCRIPT: 'scripts/cli.sh' }, { NPM_PACK_SCRIPT: 'scripts/pack.sh' },
    { CI_CHECK_EVENTS: '["push","push"]' }, { CLI_SMOKE_ARGS: '--help' },
    { DMG_LAYOUT: '{}' }, { DMG_LAYOUT: base.DMG_LAYOUT.replace('128', 'true') },
    { DMG_LAYOUT: base.DMG_LAYOUT.replace('180', '999') }, { BUILD_RUNNER: 'self-hosted' },
    { SIGNING_ENVIRONMENT: '../release' }, { XCODE_PATH: '/tmp/toolchain' },
  ]) assert.notEqual(run(patch).status, 0, JSON.stringify(patch));

  // Malformed JSON inputs name the offending input instead of surfacing a decoder traceback.
  for (const [patch, label] of [[{ CLI_SMOKE_ARGS: '--help' }, 'cli-smoke-args'], [{ CI_CHECK_EVENTS: 'push' }, 'ci-check-events'], [{ DMG_LAYOUT: 'window' }, 'dmg-layout']]) {
    const result = run(patch);
    assert.notEqual(result.status, 0, JSON.stringify(patch));
    assert.match(result.stderr, new RegExp(`ValueError: ${label} must be valid JSON`), result.stderr);
  }
});

test('notarization retries only pre-submission transient failures with injected scheduler', () => {
  python(`
from notary import submit,ticket
import json
accepted=(0,json.dumps({'status':'Accepted','id':'submission-id'}),'')
calls=[]; delays=[]
def invoke(path):
    calls.append(path)
    return (1,'','abortedUpload') if len(calls)<3 else accepted
assert submit('artifact',invoke,delays.append)['id']=='submission-id'
assert len(calls)==3 and delays==[15,30]
for response in [(1,'','invalid credentials'),(1,json.dumps({'id':'in-flight'}),'network lost'),(1,json.dumps({'id':'bad','status':'Invalid'}),'abortedUpload'),(1,json.dumps({'id':'ok','status':'Accepted'}),'timed out'),(1,json.dumps({'status':'In Progress'}),'timed out')]:
    calls=[]; delays=[]
    def invoke(path): calls.append(path); return response
    try: submit('artifact',invoke,delays.append); raise AssertionError('accepted failure')
    except RuntimeError: pass
    assert len(calls)==1 and delays==[]
calls=[]; delays=[]
def invoke(path): calls.append(path); return (1,'','connection reset')
try: submit('artifact',invoke,delays.append); raise AssertionError('unbounded retries')
except RuntimeError: pass
assert len(calls)==3 and delays==[15,30]
calls=[]; delays=[]
def online(path): calls.append(path); return int(len(calls)<3)
ticket('app',online,delays.append)
assert delays==[10,20]
`);
});

test('appcast uses escaped element-form minimum, rejects duplicates and non-monotonic builds', () => {
  python(`
from appcast import update,validate
import xml.etree.ElementTree as ET
xml='<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Fixture</title></channel></rss>'
entry=dict(title='A & B <App>',version='1.2.3',buildNumber='12',minimumSystemVersion='15.0',releaseUrl='https://example.test/?a=1&b=2',assetUrl='https://example.test/a.zip?a=1&b=2',zipLength=55,edSignature='a+b/==',pubDate='Thu, 01 Oct 2026 00:00:00 +0000')
result=update(xml,entry)
assert '<sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>' in result
assert 'A &amp; B &lt;App&gt;' in result
validate(result,entry)
for candidate in [entry,dict(entry,version='1.2.4',buildNumber='12'),dict(entry,version='1.2.4',buildNumber='11'),dict(entry,buildNumber='0')]:
    try: update(result,candidate); raise AssertionError('accepted invalid appcast')
    except ValueError: pass
new=update(result,dict(entry,version='1.2.4',buildNumber='13'))
validate(new,dict(entry,version='1.2.4',buildNumber='13'))
try: validate(new.replace('<sparkle:minimumSystemVersion>15.0</sparkle:minimumSystemVersion>',''),dict(entry,version='1.2.4',buildNumber='13')); raise AssertionError('missing element accepted')
except ValueError: pass
for invalid in ['<!DOCTYPE rss [<!ENTITY bad "bad">]>'+xml,xml.replace('</channel>','</channel><channel/>')]:
    try: update(invalid,entry); raise AssertionError('bad XML accepted')
    except ValueError: pass
`);
});

test('appcast preserves repeated historical builds while requiring every new build to increase', () => {
  python(`
from appcast import update,validate
import xml.etree.ElementTree as ET
S='{http://www.andymatuschak.org/xml-namespaces/sparkle}'
xml='<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Legacy</title></channel></rss>'
root=ET.fromstring(xml)
for version,build in [('1.0.2','3'),('1.0.1','1'),('1.0.0','1'),('0.9.0-beta.1','1')]:
    item=ET.SubElement(root.find('channel'),'item')
    ET.SubElement(item,'description').text='Published release & notes for '+version
    ET.SubElement(item,'enclosure',{'url':'https://example.test/'+version+'.zip',S+'shortVersionString':version,S+'version':build})
canonical=lambda item: ET.canonicalize(ET.tostring(item,encoding='unicode'),strip_text=True)
history=[canonical(item) for item in root.findall('./channel/item')]
xml=ET.tostring(root,encoding='unicode')
entry=dict(title='New release',version='1.0.3',buildNumber='4',minimumSystemVersion='15.0',releaseUrl='https://example.test/release',assetUrl='https://example.test/new.zip',zipLength=55,edSignature='signature',pubDate='date')
result=update(xml,entry)
validate(result,entry)
assert [canonical(item) for item in ET.fromstring(result).findall('./channel/item')[1:]]==history
for candidate in [dict(entry,buildNumber='3'),dict(entry,buildNumber='1'),dict(entry,version='1.0.0')]:
    try: update(xml,candidate); raise AssertionError('accepted invalid new release')
    except ValueError: pass
for bad_build in ['4','5']:
    tampered=ET.fromstring(result)
    tampered.findall('./channel/item')[1].find('enclosure').set(S+'version',bad_build)
    try: validate(ET.tostring(tampered,encoding='unicode'),entry); raise AssertionError('accepted non-increasing new build')
    except ValueError: pass
bad_history=ET.fromstring(xml)
bad_history.findall('./channel/item')[2].find('enclosure').set(S+'version','2')
bad_history.findall('./channel/item')[1].find('enclosure').set(S+'version','1')
try: update(ET.tostring(bad_history,encoding='unicode'),entry); raise AssertionError('accepted increasing history')
except ValueError: pass
`);
});

test('Sparkle private seed derives the configured public key and verifies exact ZIP bytes', () => {
  const require = createRequire(import.meta.url);
  const tool = require(join(root, 'sparkle.cjs'));
  const pair = generateKeyPairSync('ed25519');
  const pub = pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64');
  const seed = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).subarray(-32).toString('base64');
  const file = join(root, 'app.zip');
  const bytes = Buffer.from('synthetic signed ZIP'); writeFileSync(file, bytes);
  tool.checkPrivate(seed, pub);
  assert.throws(() => tool.checkPrivate(seed, Buffer.alloc(32).toString('base64')), /mismatch/);
  assert.throws(() => tool.checkPrivate('bad', pub), /32-byte seed/);
  const signature = sign(null, bytes, pair.privateKey).toString('base64');
  tool.verify(file, signature, pub);
  writeFileSync(file, 'changed ZIP');
  assert.throws(() => tool.verify(file, signature, pub), /mismatch/);
});

test('inventory binds names, checksums, source identity and sizes', () => {
  python(`
from pathlib import Path
from inventory import freeze,verify
import json
root=Path('assets'); root.mkdir()
(root/'app.zip').write_bytes(b'zip')
(root/'appcast.xml').write_bytes(b'xml')
freeze(root,'checksums.txt','openclaw/fixture','v1.2.3','abc')
verify(root,'checksums.txt','openclaw/fixture','v1.2.3','abc')
for scenario in ['extra','changed','identity','missing','duplicate']:
    snapshot={p.name:p.read_bytes() for p in root.iterdir()}
    if scenario=='extra': (root/'extra.zip').write_bytes(b'extra')
    if scenario=='changed': (root/'app.zip').write_bytes(b'other')
    if scenario=='identity':
        data=json.loads((root/'ASSET-INVENTORY.json').read_text()); data['commit']='other'; (root/'ASSET-INVENTORY.json').write_text(json.dumps(data))
    if scenario=='missing': (root/'app.zip').unlink()
    if scenario=='duplicate':
        p=root/'checksums.txt'; p.write_text(p.read_text()+p.read_text().splitlines()[0]+'\\n')
    try: verify(root,'checksums.txt','openclaw/fixture','v1.2.3','abc'); raise AssertionError(scenario)
    except (ValueError,FileNotFoundError): pass
    for p in root.iterdir(): p.unlink()
    for name,data in snapshot.items(): (root/name).write_bytes(data)
`);
});

test('DMG/ZIP tree equality includes bytes, modes, and symlink destinations', () => {
  python(`
from inventory import equal_trees
from pathlib import Path
import os,shutil
left=Path('tree-left');left.mkdir();(left/'binary').write_bytes(b'bin');(left/'link').symlink_to('binary')
right=Path('tree-right');shutil.copytree(left,right,symlinks=True)
equal_trees(left,right)
for scenario in ['bytes','mode','link','extra']:
    shutil.rmtree(right); shutil.copytree(left,right,symlinks=True)
    if scenario=='bytes': (right/'binary').write_bytes(b'changed')
    if scenario=='mode': (right/'binary').chmod(0o700)
    if scenario=='link': (right/'link').unlink();(right/'link').symlink_to('/outside')
    if scenario=='extra': (right/'extra').write_bytes(b'x')
    try: equal_trees(left,right);raise AssertionError(scenario)
    except (ValueError,FileNotFoundError): pass
`);
});

test('unsafe archive paths, ambiguous members, hardlinks and escaping symlinks fail before extraction', () => {
  python(`
from unpack import unpack
from pathlib import Path
import tarfile,io,zipfile,stat
for index,case in enumerate(['traversal','absolute','hardlink','escape','duplicate','under-link','cycle']):
    path=Path('unsafe-'+str(index)+'.tgz')
    with tarfile.open(path,'w:gz') as archive:
        names=['app/file']
        if case=='traversal': names=['app/../file']
        if case=='absolute': names=['/app/file']
        if case=='duplicate': names=['app/file','app/FILE']
        if case=='under-link': names=['app/link','app/link/file']
        if case=='cycle': names=['app/link']
        for name in names:
            member=tarfile.TarInfo(name)
            if case in ('hardlink','escape','under-link','cycle') and name==names[0]:
                member.type=tarfile.LNKTYPE if case=='hardlink' else tarfile.SYMTYPE
                member.linkname='link' if case=='cycle' else '../../outside' if case=='escape' else 'file'
                archive.addfile(member)
            else: member.size=1;archive.addfile(member,io.BytesIO(b'x'))
    try: unpack(str(path),'unsafe-output-'+str(index),'app','tar');raise AssertionError(case)
    except ValueError: pass
    assert not Path('unsafe-output-'+str(index)).exists()
`);
});

test('npm archive embeds byte-identical executable and companions', () => {
  python(`
from npm import verify_package
from pathlib import Path
import tarfile,io,json
cli=Path('cli.tgz')
def add(archive,name,data,mode=0o755):
    p=tarfile.TarInfo(name);p.size=len(data);p.mode=mode;archive.addfile(p,io.BytesIO(data))
with tarfile.open(cli,'w:gz') as archive:
    add(archive,'fixture-universal/tool',b'binary');add(archive,'fixture-universal/runtime.dylib',b'library')
for case in ('valid','changed','library','mode','duplicate','version'):
    npm=Path('npm-'+case+'.tgz')
    with tarfile.open(npm,'w:gz') as archive:
        add(archive,'package/package.json',json.dumps({'version':'1.2.4' if case=='version' else '1.2.3'}).encode())
        add(archive,'package/bin/tool',b'other' if case=='changed' else b'binary',0o644 if case=='mode' else 0o755)
        add(archive,'package/bin/runtime.dylib',b'other' if case=='library' else b'library')
        if case=='duplicate': add(archive,'package/bin/tool',b'binary')
    if case=='valid': verify_package(cli,npm,'fixture','tool','1.2.3')
    else:
        try:verify_package(cli,npm,'fixture','tool','1.2.3');raise AssertionError(case)
        except ValueError:pass
`);
});

test('Swift runtime audit follows architecture-specific reexports and refuses missing imports', () => {
  python(`
from runtime import *
from pathlib import Path
import runtime
libraries={}
tbd=b'''--- !tapi-tbd\ntbd-version: 4\ntargets: [ arm64-macos, x86_64-macos ]\ninstall-name: /usr/lib/swift/libswiftCore.dylib\nreexported-libraries:\n  - targets: [ arm64-macos ]\n    libraries: [ /usr/lib/swift/libswiftMore.dylib ]\n...\n'''
parse_tbd(Path('Core.tbd'),tbd,libraries)
assert reachable(libraries,'arm64','libswiftCore')=={'libswiftCore','libswiftMore'}
assert reachable(libraries,'x86_64','libswiftCore')=={'libswiftCore'}
runtime.run=lambda args:'(undefined) external _swift_initBorrow (from libswiftCore)'
try:strong_imports('binary','arm64');raise AssertionError('strong import accepted')
except AuditError:pass
runtime.run=lambda args:'(undefined) weak external _swift_initBorrow (from libswiftCore)'
assert strong_imports('binary','arm64')==set()
assert choose_sdk([SDK(Path('new'),'27.0','macosx','1'),SDK(Path('old'),'26.0','macosx','1')],'15.0').version=='26.0'
try:choose_sdk([SDK(Path('new'),'27.0','macosx','1')],'15.0');raise AssertionError('missing older SDK accepted')
except AuditError:pass
`);
});

test('Sparkle sealing walks physical helpers before their framework and the main app', () => {
  python(`
import signing,plistlib
from pathlib import Path
root=Path('Signing.app').resolve();version=root/'Contents/Frameworks/Sparkle.framework/Versions/B'
version.mkdir(parents=True)
framework=version.parent.parent
(framework/'Versions/Current').symlink_to('B')
for bundle in [version/'XPCServices/Downloader.xpc',version/'XPCServices/Installer.xpc',version/'Updater.app']:
    (bundle/'Contents/MacOS').mkdir(parents=True)
    (bundle/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'helper'}))
    (bundle/'Contents/MacOS/helper').write_bytes(b'macho')
for name in ('Autoupdate','Sparkle'):(version/name).write_bytes(b'macho')
for name,target in [('Autoupdate','Versions/Current/Autoupdate'),('Updater.app','Versions/Current/Updater.app'),('XPCServices','Versions/Current/XPCServices'),('Sparkle','Versions/Current/Sparkle')]:
    (framework/name).symlink_to(target)
signing.os.environ['MINIMUM_SYSTEM_VERSION']='15.0'
signing.check_deployment=lambda *args:None
signing.subprocess.check_output=lambda args,**kwargs: 'Mach-O' if Path(args[-1]).read_bytes()==b'macho' else 'data'
paths=signing.signing_paths(root)
for item in [version/'XPCServices/Downloader.xpc',version/'XPCServices/Installer.xpc',version/'Autoupdate',version/'Updater.app']:
    assert paths.index(item)<paths.index(framework)
assert all(not p.is_symlink() for p in paths)
(version/'Autoupdate').unlink()
try:signing.signing_paths(root);raise AssertionError('missing helper accepted')
except (ValueError,FileNotFoundError):pass
`);
});

test('Downloader reapplies frozen entitlements to both signing passes and checks every slice', () => {
  python(`
import downloader,signing,plistlib,subprocess,os
from pathlib import Path
from unittest.mock import patch
root=Path('Downloader.app').resolve();version=root/'Contents/Frameworks/Sparkle.framework/Versions/B'
bundle=version/'XPCServices/Downloader.xpc';binary=bundle/'Contents/MacOS/Downloader'
binary.parent.mkdir(parents=True);binary.write_bytes(b'macho')
(bundle/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'Downloader'}))
(version.parent/'Current').symlink_to('B')
other=version/'Autoupdate';other.write_bytes(b'macho')
sandbox={'com.apple.security.network.client':True,'com.apple.security.app-sandbox':True,'fixture':{'b':2,'a':[True,'value']}}
os.environ.update(RUNNER_TEMP=str(Path('.').resolve()),KEYCHAIN='fixture',IDENTITY='fixture')
for initial in (sandbox,{}):
    state={(str(p),a):dict(initial) for p in (bundle,binary) for a in ('arm64','x86_64')}
    calls=[]
    def run(args,**kwargs):
        path=args[-1]
        if '--display' in args:
            value=state[(path,args[args.index('--arch')+1])]
            return subprocess.CompletedProcess(args,0,plistlib.dumps(value,sort_keys=False) if value else b'',b'')
        calls.append(args)
        data=plistlib.loads(Path(args[args.index('--entitlements')+1]).read_bytes()) if '--entitlements' in args else {}
        if path in (str(binary),str(bundle)):
            for arch in ('arm64','x86_64'):state[(str(binary),arch)]=state[(str(bundle),arch)]=data
        return subprocess.CompletedProcess(args,0)
    with patch('subprocess.run',run),patch.object(signing,'signing_paths',lambda app:[binary,bundle,other]):
        record=downloader.capture(root)
        assert plistlib.loads(record['entitlements'].encode('utf-8'))==initial
        downloader.sign(root,record)
        assert [args[-1] for args in calls]==[str(binary),str(bundle),str(other)]
        assert all(('--entitlements' in args)==bool(initial) for args in calls[:2])
        assert calls[-1]==['codesign','--force','--timestamp','--options','runtime','--keychain','fixture','--sign','fixture',str(other)]
        downloader.verify(root,record)
        for value in ({},dict(initial,unexpected=True),dict(initial,**{'com.apple.security.app-sandbox':False}),dict(initial,**{'com.apple.security.network.client':False})):
            if value==initial:continue
            for target in ((str(binary),'arm64'),(str(bundle),'x86_64')):
                before=state[target];state[target]=value
                try:downloader.verify(root,record);raise AssertionError('changed entitlement accepted')
                except ValueError:pass
                state[target]=before
        changed=dict(record,bundle='Contents/wrong.xpc')
        try:downloader.verify(root,changed);raise AssertionError('changed bundle accepted')
        except ValueError:pass
        # A record change cannot redirect signing away from the frozen input.
        calls.clear()
        try:downloader.sign(root,dict(record,entitlements=downloader.canonical({'injected':True})));raise AssertionError('changed record accepted')
        except ValueError:pass
        assert calls==[]
for code,out,err,accepted in [(1,b'',b'fixture: code object is not signed at all\\n',True),(1,b'',b'malformed signature',False),(0,b'bad plist',b'',False)]:
    with patch('subprocess.run',lambda *a,**k:subprocess.CompletedProcess(a,code,out,err)):
        if accepted:
            assert plistlib.loads(downloader.read(binary,'arm64',allow_unsigned=True).encode('utf-8'))=={}
            try:downloader.read(binary,'arm64');raise AssertionError('unsigned verifier input accepted')
            except ValueError:pass
        else:
            try:downloader.read(binary,'arm64',allow_unsigned=True);raise AssertionError('unreadable signature accepted')
            except (ValueError,plistlib.InvalidFileException):pass
`);
});

test('native ad-hoc Downloader signatures preserve sandbox and empty entitlements', { skip: process.platform !== 'darwin' }, () => {
  python(`
import downloader,signing,plistlib,subprocess,os
from pathlib import Path
from unittest.mock import patch
root=Path('Native.app').resolve();version=root/'Contents/Frameworks/Sparkle.framework/Versions/B'
bundle=version/'XPCServices/Downloader.xpc';binary=bundle/'Contents/MacOS/Downloader'
binary.parent.mkdir(parents=True)
(bundle/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleExecutable':'Downloader','CFBundleIdentifier':'org.example.downloader','CFBundlePackageType':'XPC!'}))
(version.parent/'Current').symlink_to('B')
Path('main.c').write_text('int main(void) { return 0; }')
subprocess.run(['clang','-arch','arm64','-arch','x86_64','-mmacosx-version-min=15.0','main.c','-o',str(binary)],check=True)
os.environ.update(RUNNER_TEMP=str(Path('.').resolve()),KEYCHAIN='/dev/null',IDENTITY='-')
for initial in ({'com.apple.security.app-sandbox':True,'com.apple.security.network.client':True},{}):
    Path('native.entitlements').write_bytes(plistlib.dumps(initial))
    subprocess.run(['codesign','--force','--sign','-','--entitlements','native.entitlements',str(bundle)],check=True)
    record=downloader.capture(root)
    assert plistlib.loads(record['entitlements'].encode('utf-8'))==initial
    with patch.object(signing,'signing_paths',lambda app:[binary,bundle]):downloader.sign(root,record)
    downloader.verify(root,record)
    subprocess.run(['codesign','--verify','--strict',str(bundle)],check=True)
    subprocess.run(['codesign','--force','--sign','-',str(bundle)],check=True)
    if initial:
        try:downloader.verify(root,record);raise AssertionError('stripped sandbox accepted')
        except ValueError:pass
    else:downloader.verify(root,record)
`);
});

test('built Info.plist refuses signed feeds before Mach-O work but permits archive preverification', () => {
  python(`
import metadata,plistlib,os
from pathlib import Path
from unittest.mock import patch
root=Path('Feed.app');(root/'Contents').mkdir(parents=True)
base=dict(CFBundleShortVersionString='1.2.3',CFBundleIdentifier='org.example.feed',LSMinimumSystemVersion='15.0',SUFeedURL='https://example.test/feed.xml',SUPublicEDKey='key',CFBundleVersion='12',CFBundleExecutable='Feed')
os.environ.update(VERSION='1.2.3',BUNDLE_IDENTIFIER='org.example.feed',MINIMUM_SYSTEM_VERSION='15.0',APPCAST_FEED_URL=base['SUFeedURL'],SPARKLE_PUBLIC_KEY='key')
for required in (None,False,True,'YES',1):
    for before in (False,True):
        data=dict(base,SUVerifyUpdateBeforeExtraction=before)
        if required is not None:data['SURequireSignedFeed']=required
        (root/'Contents/Info.plist').write_bytes(plistlib.dumps(data))
        with patch.object(metadata,'check_deployment'),patch('subprocess.check_output',return_value='arm64 x86_64') as command:
            if required is None or required is False:metadata.check(root)
            else:
                try:metadata.check(root);raise AssertionError('signed feed accepted')
                except ValueError as error:assert 'SURequireSignedFeed' in str(error) and 'unsigned appcast' in str(error)
                command.assert_not_called()
`);
});

test('post-sign caller packaging cannot replace the original signed artifact', () => {
  python(`
from pathlib import Path
from inventory import bind_signed
left=Path('signer-original');right=Path('package-final');left.mkdir();right.mkdir()
for name in ('app.zip','SIGNING-MANIFEST.json'):
    (left/name).write_bytes(b'signer');(right/name).write_bytes(b'signer')
bind_signed(left,right)
(right/'SIGNING-MANIFEST.json').write_bytes(b'caller manifest')
try:bind_signed(left,right);raise AssertionError('caller replaced signer proof')
except ValueError:pass
`);
});

test('release transport rejects overwrite, import-shadowing, links and nested payloads before writing', () => {
  python(`
from payload import unpack_payload
from pathlib import Path
import tarfile,io
for index,(name,kind) in enumerate([('json.py','file'),('../source-original/appcast.xml','file'),('signer-original/signed-sparkle.tar.gz','file'),('release-assets/subdir/evil','file'),('release-assets/link','link'),('release-assets/app.zip','valid')]):
    archive=Path('transport-'+str(index)+'.tgz'); destination=Path('isolated-'+str(index))
    with tarfile.open(archive,'w:gz') as output:
        item=tarfile.TarInfo(name)
        if kind=='link':item.type=tarfile.SYMTYPE;item.linkname='../outside';output.addfile(item)
        else:item.size=1;output.addfile(item,io.BytesIO(b'x'))
    if kind=='valid':
        unpack_payload(archive,destination)
        assert (destination/'release-assets/app.zip').read_bytes()==b'x'
    else:
        try:unpack_payload(archive,destination);raise AssertionError(name)
        except ValueError:pass
        assert not destination.exists()
`);
});

test('companion dylibs inherit executable run paths and install IDs are not dependencies', () => {
  python(`
import runtime_libraries as runtime
from pathlib import Path
root=Path('rpath-fixture');root.mkdir()
for name in ('tool','libfoo.dylib'):(root/name).write_bytes(b'macho')
def read(*args):
    if args[0]=='lipo':return 'arm64 x86_64'
    if args[-1].endswith('tool'):
        return 'cmd LC_RPATH\\n path @executable_path (offset 12)\\ncmd LC_LOAD_DYLIB\\n name @rpath/libfoo.dylib (offset 24)\\n'
    return 'cmd LC_ID_DYLIB\\n name @rpath/libfoo.dylib (offset 24)\\n'
runtime.read=read
runtime.check_companions(root,'tool')
(root/'libfoo.dylib').unlink()
try:runtime.check_companions(root,'tool');raise AssertionError('missing dylib accepted')
except ValueError:pass
`);
});

test('Mach-O deployment targets cannot contradict the declared minimum OS', () => {
  python(`
from contract import check_deployment
from unittest.mock import patch
for value in ('14.0','15.0','26.0'):
    def output(args,**kw):
        return 'arm64 x86_64' if args[0]=='lipo' else 'cmd LC_BUILD_VERSION\\n platform 1\\n minos '+value+'\\n'
    with patch('subprocess.check_output',output):
        if value!='26.0':check_deployment('binary','15.0')
        else:
            try:check_deployment('binary','15.0');raise AssertionError('newer minimum accepted')
            except ValueError:pass
`);
});

test('deployment parsers require a valid macOS minimum in every slice and ignore only Catalyst', () => {
  python(`
from contract import check_deployment
import runtime
from unittest.mock import patch
def build(platform,minimum):return 'cmd LC_BUILD_VERSION\\n platform '+platform+'\\n minos '+minimum+'\\n'
def legacy(minimum):return 'cmd LC_VERSION_MIN_MACOSX\\n version '+minimum+'\\n'
def check(slices,expected=None,too_new=False):
    def output(args,**kw):return ' '.join(slices) if args[0]=='lipo' else slices[args[2]]
    with patch('subprocess.check_output',output):
        if expected is None or too_new:
            try:check_deployment('binary','15.0');raise AssertionError('invalid deployment accepted: '+repr(slices))
            except ValueError:pass
        else:check_deployment('binary','15.0')
    for arch,text in slices.items():
        with patch.object(runtime,'run',return_value=text):
            if expected is None:
                try:runtime.minimum_macos('binary',arch);raise AssertionError('invalid runtime minimum accepted: '+text)
                except runtime.AuditError:pass
            else:assert runtime.minimum_macos('binary',arch)==expected[arch]
for macos in ('1','macos','MACOS'):
    for catalyst in ('6','maccatalyst','MACCATALYST'):
        for text in (build(macos,'11.0')+build(catalyst,'26.0'),build(catalyst,'26.0')+build(macos,'11.0')):
            check({'arm64':text},{'arm64':'11.0'})
for text in (legacy('10.15'),build('6','26.0')+legacy('10.15')):
    check({'x86_64':text},{'x86_64':'10.15'})
check({'arm64':build('1','11.0')+build('1','14.0')},{'arm64':'14.0'})
check({'x86_64':build('1','11.0')+legacy('15.1')+build('6','26.0')},{'x86_64':'15.1'},too_new=True)
check({'arm64':build('1','11.0'),'x86_64':build('1','15.1')+build('6','26.0')},{'arm64':'11.0','x86_64':'15.1'},too_new=True)
for platform in ('2','ios','7','iossimulator','10','driverkit','unknown',''):
    for text in (build(platform,'11.0'),build('1','11.0')+build(platform,'11.0')):
        check({'arm64':text})
for minimum in ('','bad','11.x','-1','11..0'):
    for text in (build('1',minimum),build('1','11.0')+build('1',minimum),legacy(minimum)):
        check({'arm64':text})
for text in ('',build('6','14.0'),build('maccatalyst','26.0')):
    check({'arm64':text})
# A valid first slice must not hide a Catalyst-only later slice.
with patch('subprocess.check_output',lambda args,**kw:'arm64 x86_64' if args[0]=='lipo' else build('1' if args[2]=='arm64' else '6','11.0')):
    try:check_deployment('binary','15.0');raise AssertionError('Catalyst-only second slice accepted')
    except ValueError:pass
`);
});

test('native macOS and zippered dylibs retain only macOS deployment minima', { skip: process.platform !== 'darwin' }, async (t) => {
  writeFileSync(join(root, 'deployment.c'), 'int fixture(void) { return 42; }\n');
  function build(name, target, variant, sdk = 'macosx') {
    const result = spawnSync('xcrun', ['--sdk', sdk, 'clang', '-dynamiclib', '-target', target,
      ...(variant ? ['-darwin-target-variant', variant] : []), 'deployment.c', '-o', name],
    { cwd: root, encoding: 'utf8', timeout: 60_000 });
    return { ...result, name };
  }
  function available(result, context) {
    assert.ifError(result.error);
    if (result.status === 0) return true;
    assert.match(result.stderr, /SDK .* cannot be located|unable to find utility "clang"|(?:unsupported option|unknown argument):? ['"]-darwin-target-variant['"]|(?:unsupported|not supported).*\b(?:macabi|macCatalyst)\b|\b(?:macabi|macCatalyst)\b.*(?:unsupported|not supported)|library (?:not found for -lSystem|'System' not found)/i,
      `unexpected compiler failure for ${result.name}: ${result.stderr}`);
    context.skip(`local SDK/toolchain cannot build ${result.name}: ${result.stderr}`);
    return false;
  }
  function commands(name, arch) {
    const result = spawnSync('otool', ['-arch', arch, '-l', name], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const blocks = result.stdout.split(/^\s*cmd /m).filter((block) => block.startsWith('LC_BUILD_VERSION\n'));
    return blocks.map((block) => [block.match(/^\s*platform\s+(\S+)/m)?.[1].toLowerCase(), block.match(/^\s*minos\s+(\S+)/m)?.[1]]);
  }
  function macosMinimum(name, arch, expected) {
    python(`from runtime import minimum_macos\nassert minimum_macos(${JSON.stringify(name)},${JSON.stringify(arch)})==${JSON.stringify(expected)}`);
  }
  await t.test('macOS-only dylib passes', () => {
    const result = build('macos-only.dylib', 'arm64-apple-macos11');
    assert.equal(result.status, 0, result.error ?? result.stderr);
    python("from contract import check_deployment\ncheck_deployment('macos-only.dylib','15.0')");
    macosMinimum(result.name, 'arm64', '11.0');
  });
  await t.test('zippered arm64 and optional universal dylib pass with macOS 11.0', (context) => {
    const arm = build('zippered-arm64.dylib', 'arm64-apple-macos11', 'arm64-apple-ios14.0-macabi');
    if (!available(arm, context)) return;
    const intel = build('zippered-x86_64.dylib', 'x86_64-apple-macos11', 'x86_64-apple-ios14.0-macabi');
    const intelAvailable = available(intel, { skip: (reason) => context.diagnostic(`optional x86_64 slice skipped: ${reason}`) });
    const arches = intelAvailable ? ['arm64', 'x86_64'] : ['arm64'];
    let name = arm.name;
    if (intelAvailable) {
      name = 'zippered-universal.dylib';
      const merged = spawnSync('lipo', ['-create', arm.name, intel.name, '-output', name], { cwd: root, encoding: 'utf8' });
      assert.equal(merged.status, 0, merged.stderr);
    }
    for (const arch of arches) {
      const observed = commands(name, arch);
      assert.deepEqual(observed, [['1', '11.0'], ['6', '14.0']]);
      context.diagnostic(`otool -arch ${arch} -l ${name}: ${JSON.stringify(observed)}`);
      macosMinimum(name, arch, '11.0');
    }
    python(`from contract import check_deployment\ncheck_deployment(${JSON.stringify(name)},'15.0')`);
  });
  await t.test('zippered macOS minimum above 15.0 fails', (context) => {
    const result = build('zippered-newer.dylib', 'arm64-apple-macos15.1', 'arm64-apple-ios18.2-macabi');
    if (!available(result, context)) return;
    assert.deepEqual(commands(result.name, 'arm64'), [['1', '15.1'], ['6', '18.2']]);
    macosMinimum(result.name, 'arm64', '15.1');
    python(`from contract import check_deployment
try:check_deployment('zippered-newer.dylib','15.0');raise AssertionError('newer macOS accepted')
except ValueError as error:assert 'newer macOS' in str(error)`);
  });
  for (const [label, target, sdk, platform] of [
    ['Catalyst', 'arm64-apple-ios14.0-macabi', 'macosx', '6'],
    ['iOS', 'arm64-apple-ios14.0', 'iphoneos', '2'],
  ]) await t.test(`${label}-only dylib fails both deployment parsers`, (context) => {
    const result = build(`${label}-only.dylib`, target, null, sdk);
    if (!available(result, context)) return;
    assert.deepEqual(commands(result.name, 'arm64'), [[platform, '14.0']]);
    python(`from contract import check_deployment
from runtime import minimum_macos,AuditError
try:check_deployment(${JSON.stringify(result.name)},'15.0');raise AssertionError('non-macOS accepted')
except ValueError:pass
try:minimum_macos(${JSON.stringify(result.name)},'arm64');raise AssertionError('non-macOS runtime accepted')
except AuditError:pass`);
  });
});

test('production attestation preserves CRLF release-note bytes', () => {
  const run = workflowStep(workflow, 'verify', 'name', 'Verify inventory, Sparkle signature, sealed app, DMG, and CLI').run;
  const program = run.split("python3 - <<'PYCODE'\n").at(-1).split('\nPYCODE')[0];
  python(`from pathlib import Path\nPath('release-assets').mkdir(exist_ok=True)\nfor name,data in [('RELEASE-NOTES.md',b'line one\\r\\nline two\\r\\n'),('ASSET-INVENTORY.json',b'{}'),('checksums.txt',b'hashes\\n')]: (Path('release-assets')/name).write_bytes(data)`);
  const result = spawnSync('python3', ['-c', program], { cwd: root, env: { ...process.env, CHECKSUM_FILENAME: 'checksums.txt', GITHUB_REPOSITORY: 'openclaw/fixture', GITHUB_RUN_ID: '1', PAYLOAD_ARTIFACT: 'payload', TAG: 'v1.2.3', TARGET_SHA: 'commit', EXPECTED_ARCH: 'arm64', VERIFY_RUNNER: 'xcode-27', VERIFIER_ID: 'arm64' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(readFileSync(join(root, 'verified-sparkle-attestation.json'), 'utf8')).releaseNotes, 'line one\r\nline two\r\n');
});

test('unrecognized final archives cannot piggyback on a valid signed payload', () => {
  python(`
from pathlib import Path
from inventory import bind_signed
left=Path('allowlist-original');right=Path('allowlist-final');left.mkdir();right.mkdir()
(left/'app.zip').write_bytes(b'signed');(right/'app.zip').write_bytes(b'signed')
for name in ('RELEASE-NOTES.md','appcast.xml','appcast-entry.json','ASSET-INVENTORY.json','checksums.txt'):(right/name).write_bytes(b'control')
bind_signed(left,right,'checksums.txt',False)
(right/'unsigned.tar.gz').write_bytes(b'unsigned')
try:bind_signed(left,right,'checksums.txt',False);raise AssertionError('extra archive accepted')
except ValueError:pass
(right/'unsigned.tar.gz').unlink();(right/'package.tgz').write_bytes(b'package')
try:bind_signed(left,right,'checksums.txt',False);raise AssertionError('unrequested npm accepted')
except ValueError:pass
bind_signed(left,right,'checksums.txt',True)
`);
});

test('release staging resets the private-key umask for distributable modes', () => {
  const run = workflowStep(workflow, 'sign', 'name', 'Sign app inside out and notarize release payload').run;
  const permissions = extractMarkedSource(run, '# BEGIN release-staging-permissions', '# END release-staging-permissions');
  writeFileSync(join(root, 'source-cli'), 'executable', { mode: 0o755 });
  const second = spawnSync('bash', ['-c', `set -euo pipefail\numask 077\nprintf fixture > private-seed\n${permissions}\nmkdir public-cli-complete\ncp source-cli public-cli-complete/tool`], { cwd: root, encoding: 'utf8' });
  assert.equal(second.status, 0, second.stderr);
  python(`import stat\nfrom pathlib import Path\nassert stat.S_IMODE(Path('public-cli-complete').stat().st_mode)==0o755\nassert stat.S_IMODE(Path('public-cli-complete/tool').stat().st_mode)==0o755\nassert stat.S_IMODE(Path('private-seed').stat().st_mode)==0o600`);
});

test('prerelease appcast items stay off the default Sparkle update channel', () => {
  python(`
from appcast import update,validate
xml='<rss xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel/></rss>'
base=dict(title='Fixture',buildNumber='12',minimumSystemVersion='15.0',releaseUrl='https://example.test/release',assetUrl='https://example.test/app.zip',zipLength=55,edSignature='signature',pubDate='date')
for channel in ('alpha','beta','rc'):
    entry=dict(base,version='1.2.3-'+channel+'.1')
    result=update(xml,entry)
    marker='<sparkle:channel>'+channel+'</sparkle:channel>'
    assert marker in result
    validate(result,entry)
    for changed in (result.replace(marker,''),result.replace(marker,'<sparkle:channel>wrong</sparkle:channel>')):
        try:validate(changed,entry);raise AssertionError('wrong channel accepted')
        except ValueError:pass
stable=update(xml,dict(base,version='1.2.3'))
assert '<sparkle:channel>' not in stable
`);
});

 test('CLI version checks require exact SemVer equality', () => {
  python(`
from contract import cli_version_matches
assert cli_version_matches('Peekaboo 1.2.3 (build 44)', '1.2.3')
assert not cli_version_matches('Peekaboo 1.2.30', '1.2.3')
assert not cli_version_matches('Peekaboo 1.2.3-beta.1', '1.2.3')
assert cli_version_matches('Peekaboo 1.2.3-beta.1', '1.2.3-beta.1')
`);
});

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'win32') throw Error('Windows MSI build requires Windows');
const candidate = fs.realpathSync(process.argv[2] || '');
const manifest = JSON.parse(fs.readFileSync(path.join(candidate, 'package-manifest.json'), 'utf8'));
if (!manifest.community || manifest.license !== 'Apache-2.0' || manifest.bundledNativeDependencies || manifest.bundledRuntime) {
  throw Error('Only a community candidate without bundled third-party runtimes can be built');
}
const wix = process.env.MANJU_WIX_DIR;
if (!wix) throw Error('Set MANJU_WIX_DIR to the WiX Toolset directory containing candle.exe and light.exe');
const version = JSON.parse(fs.readFileSync(path.join(candidate, 'release.json'), 'utf8')).version;
const output = path.resolve(process.argv[3] || 'deliverables/installers');
fs.mkdirSync(output, {recursive: true});
fs.mkdirSync(path.resolve('.test-temp'), {recursive: true});
const temp = fs.mkdtempSync(path.resolve('.test-temp/installer-build-'));
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const id = value => 'I' + createHash('sha256').update(value).digest('hex').slice(0, 30);
const guid = value => {
  const hash = createHash('sha256').update('wanling-manju-community:' + value).digest('hex');
  return `{${hash.slice(0,8)}-${hash.slice(8,12)}-4${hash.slice(13,16)}-a${hash.slice(17,20)}-${hash.slice(20,32)}}`.toUpperCase();
};
const files = [...manifest.files.map(f => ({...f, file:f.file.replaceAll('\\', '/')})), {file: 'package-manifest.json'}];
const components = [];
const directories = new Map([['', []]]);
for (const entry of files) {
  const source = path.join(candidate, entry.file);
  if (!fs.statSync(source).isFile()) throw Error('Missing candidate file: ' + entry.file);
  if (entry.sha256 && createHash('sha256').update(fs.readFileSync(source)).digest('hex') !== entry.sha256) throw Error('Candidate hash mismatch: ' + entry.file);
  if (/(?:^|\/)(?:runtime|tools|node_modules|data|backups|\.git)(?:\/|$)|\.(?:exe|dll|node|db|sqlite|pem|key|pfx|log)$/i.test(entry.file)) throw Error('Private state or runtime in MSI candidate: ' + entry.file);
  const parts = entry.file.split('/');
  parts.pop();
  for (let n = 1; n <= parts.length; n++) {
    const parent = parts.slice(0, n-1).join('/');
    const directory = parts.slice(0, n).join('/');
    if (!directories.has(directory)) {
      directories.set(directory, []);
      directories.get(parent).push({directory});
    }
  }
  const parent = parts.join('/');
  const component = id('component:' + entry.file);
  components.push(component);
  // HKCU key paths make every component a per-user component. Files stay
  // in the current user's LocalAppData; no elevation or custom actions.
  directories.get(parent).push({text: `<Component Id="${component}" Guid="${guid('component:'+entry.file)}" Win64="yes"><File Id="${id('file:'+entry.file)}" Name="${xml(path.basename(entry.file))}" Source="${xml(source)}"/><RegistryValue Root="HKCU" Key="Software\\WanlingManjuCommunity\\Files" Name="${component}" Type="integer" Value="1" KeyPath="yes"/></Component>`});
}
function renderDirectory(directory) {
  return directories.get(directory).map(item => item.text || `<Directory Id="${id('directory:'+item.directory)}" Name="${xml(path.basename(item.directory))}">${renderDirectory(item.directory)}</Directory>`).join('\n');
}
const productCode = guid('product:'+version);
const document = `<?xml version="1.0" encoding="utf-8"?>
<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">
 <Product Id="${productCode}" Name="万灵漫剧社区版" Language="2052" Codepage="936" Version="${xml(version)}" Manufacturer="jieg19274" UpgradeCode="{E752D2FA-CB71-44AF-85A4-152F7E892AB5}">
  <Package InstallerVersion="500" Compressed="yes" InstallScope="perUser" InstallPrivileges="limited" Platform="x64" SummaryCodepage="936" Description="万灵漫剧社区版 Windows x64"/>
  <MajorUpgrade DowngradeErrorMessage="已安装更新的万灵漫剧社区版。"/>
  <MediaTemplate EmbedCab="yes"/>
  <Property Id="ARPCOMMENTS" Value="Apache-2.0 社区版；首次启动联网准备官方运行依赖。"/>
  <Property Id="ARPURLINFOABOUT" Value="https://github.com/jieg19274/wanling-manju-community"/>
  <Property Id="ARPPRODUCTICON" Value="AppIcon"/>
  <Icon Id="AppIcon" SourceFile="${xml(path.join(candidate,'dist/wanling.ico'))}"/>
  <Directory Id="TARGETDIR" Name="SourceDir">
   <Directory Id="LocalAppDataFolder"><Directory Id="INSTALLFOLDER" Name="WanlingManjuCommunity">${renderDirectory('')}</Directory></Directory>
   <Directory Id="DesktopFolder"/>
   <Directory Id="ProgramMenuFolder"><Directory Id="CommunityMenuFolder" Name="万灵漫剧社区版"/></Directory>
  </Directory>
  <DirectoryRef Id="INSTALLFOLDER"><Component Id="CommunityShortcuts" Guid="{89E7D162-27E6-455A-9552-CE5AB6247EAB}" Win64="yes">
   <Shortcut Id="DesktopShortcut" Directory="DesktopFolder" Name="万灵漫剧社区版" Target="[System64Folder]WindowsPowerShell\\v1.0\\powershell.exe" Arguments="-NoProfile -ExecutionPolicy Bypass -File &quot;[INSTALLFOLDER]scripts\\launch-community.ps1&quot;" WorkingDirectory="INSTALLFOLDER" Icon="AppIcon"/>
   <Shortcut Id="MenuShortcut" Directory="CommunityMenuFolder" Name="万灵漫剧社区版" Target="[System64Folder]WindowsPowerShell\\v1.0\\powershell.exe" Arguments="-NoProfile -ExecutionPolicy Bypass -File &quot;[INSTALLFOLDER]scripts\\launch-community.ps1&quot;" WorkingDirectory="INSTALLFOLDER" Icon="AppIcon"/>
   <RemoveFolder Id="RemoveMenuFolder" Directory="CommunityMenuFolder" On="uninstall"/>
   <RegistryValue Root="HKCU" Key="Software\\WanlingManjuCommunity" Name="InstallationRoot" Value="[INSTALLFOLDER]" Type="string" KeyPath="yes"/>
  </Component></DirectoryRef>
  <Feature Id="CommunityApplication" Title="万灵漫剧社区版" Level="1">${components.map(component => `<ComponentRef Id="${component}"/>`).join('')}<ComponentRef Id="CommunityShortcuts"/></Feature>
 </Product>
</Wix>`;
const wxs = path.join(temp, 'community.wxs');
const wixobj = path.join(temp, 'community.wixobj');
const installer = path.join(output, `wanling-manju-${version}-community-windows-x64.msi`);
fs.writeFileSync(wxs, document);
function compile(tool, args) {
  try {
    const log = execFileSync(path.join(wix,tool), args, {encoding:'utf8', windowsHide:true});
    fs.writeFileSync(path.join(temp, tool+'.log'), log);
  } catch (error) {
    const log = String(error.stdout || '') + String(error.stderr || '');
    const file = path.join(temp, tool+'.log');
    fs.writeFileSync(file, log);
    const messages = [...new Set(log.split(/\r?\n/).filter(line=>line.includes('error ')).map(line=>line.replace(/^.* : error /,'error ')))].slice(0,3);
    throw Error(`${tool} failed: ${messages.join('\n')}\nFull log: ${file}`);
  }
}
compile('candle.exe', ['-nologo', '-arch', 'x64', '-out', wixobj, wxs]);
compile('light.exe', ['-nologo', '-sval', '-out', installer, wixobj]);
const result = {installer, sourceCandidate: candidate, productCode, sha256: createHash('sha256').update(fs.readFileSync(installer)).digest('hex'), bytes: fs.statSync(installer).size, perUser: true, customActions: false, bundledNativeDependencies: false};
fs.writeFileSync(path.join(output,'installer-build.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));

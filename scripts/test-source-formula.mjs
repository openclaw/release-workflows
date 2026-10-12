#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { loadWorkflow, workflowStep } from './workflow-source.cjs';
for(const name of ['release-source.yml','release-npm-package.yml']){
  const code=workflowStep(loadWorkflow(name),'handoff','name','Hand verified release to configured tap').with.script;
  const parser=code.split('const parser=String.raw`')[1].split('`;')[0];
  const valid='class Fixture < Formula\n desc "Fixture"\n url "https://example.com/a.tgz"\n sha256 "'+'a'.repeat(64)+'"\n depends_on "node"\n def install\n system "true"\n end\n test do\n system "true"\n end\nend\n';
  const parse=input=>JSON.parse(execFileSync('ruby',['-e',parser],{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}));
  assert.equal(parse(valid).url,'https://example.com/a.tgz');
  for(const bad of [
    valid.replace(' url ', ' # url '),
    valid.replace(' url "https://example.com/a.tgz"',' url "#{ENV.fetch(\'URL\')}"'),
    valid.replace(' depends_on "node"',' send :url, "https://evil.invalid/a"'),
    valid.replace(' depends_on "node"',' X = <<~TEXT\n url "https://decoy.invalid/a"\nTEXT'),
    valid.replace(' def install',' def url'),
    valid.replace(' depends_on "node"',' url "https://evil.invalid/a"'),
  ])assert.throws(()=>parse(bad));
}
console.log('source formula parser: literal fetch accepted; comments, interpolation, reflection, heredocs, method overrides and duplicate URL rejected');

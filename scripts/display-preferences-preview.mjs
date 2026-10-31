import path from 'node:path';
import { createCandidateServer } from './candidate-web-server.mjs';
const siteRoot = path.resolve(process.argv[2] ?? 'out');
if (path.basename(siteRoot) !== 'out') throw new Error('An exported out directory is required');
const server = await createCandidateServer({ siteRoot, port: 0 });
console.log(JSON.stringify({url:`http://127.0.0.1:${server.address().port}/`,syntheticValidationOnly:true,root:siteRoot}));

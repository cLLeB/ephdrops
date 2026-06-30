import { encryptLargeContent, decryptLargeStream, __test__ } from './large-file-crypto.js';
const CS = __test__.DEFAULT_CHUNK_SIZE; // 4MB
function streamFrom(bytes, piece) {
  let i = 0;
  return new ReadableStream({ pull(c){ if(i>=bytes.length){c.close();return;} const end=Math.min(i+piece,bytes.length); c.enqueue(bytes.subarray(i,end)); i=end; } });
}
async function roundtrip(size, piece, withLen) {
  const key = await crypto.subtle.generateKey({name:'AES-GCM',length:256}, true, ['encrypt','decrypt']);
  const plain = new Uint8Array(size);
  for(let i=0;i<size;i++) plain[i]=i & 0xff;
  const ct = await encryptLargeContent(key, plain);
  const stream = streamFrom(ct, piece);
  const out = new Uint8Array(await decryptLargeStream(key, stream, withLen?ct.length:0));
  let ok = out.length===plain.length;
  if(ok) for(let i=0;i<size;i++){ if(out[i]!==plain[i]){ok=false;break;} }
  return ok;
}
const cases = [
  ['10MB+rem', 10*1024*1024+12345],
  ['exact 2 chunks', 2*CS],
  ['1 full chunk', CS],
  ['small 100B', 100],
  ['empty', 0],
  ['just over 1 chunk', CS+1],
];
for (const [name,size] of cases) {
  for (const piece of [7, 1024*1024, CS+5]) {
    for (const withLen of [true,false]) {
      const ok = await roundtrip(size, piece, withLen);
      if(!ok) console.log('FAIL', name, 'piece='+piece, 'withLen='+withLen);
    }
  }
  console.log('OK', name);
}
console.log('all done');

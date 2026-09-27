// Makes a print-ready QR code for the album, with the guest code built in so guests go
// straight in. Usage: npm run qr -- https://your-album.fly.dev
import QRCode from 'qrcode';

const address = process.argv[2] ?? process.env.PUBLIC_URL;
if (!address) {
  console.error('Usage: npm run qr -- https://your-album.fly.dev');
  process.exit(1);
}

const url = new URL(address);
if (process.env.GUEST_CODE) url.searchParams.set('code', process.env.GUEST_CODE);
const text = url.toString();

// Level Q survives a smudge or a small print size, and a short URL keeps the code simple.
await QRCode.toFile('qr-code.svg', text, { type: 'svg', errorCorrectionLevel: 'Q', margin: 2 });
await QRCode.toFile('qr-code.png', text, { type: 'png', errorCorrectionLevel: 'Q', margin: 2, width: 1500 });

console.log(`QR code for ${text}`);
console.log('Saved qr-code.svg (best for printing) and qr-code.png. Scan it with a phone before you print!');
if (!process.env.GUEST_CODE) console.log('Note: no GUEST_CODE set, so the code opens an album anyone can use.');

// Synthetic QR Ph (EMVCo merchant-presented) payloads for tests. Everything here is made up: no real merchant,
// account or phone number. The CRC is computed here with an independent implementation of CRC-16/CCITT-FALSE.

export const tlv = (id, val) => `${id}${String(val.length).padStart(2, '0')}${val}`;

export function crc16(text) {
  let crc = 0xffff;
  for (const ch of Buffer.from(text, 'latin1')) {
    crc ^= ch << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export const FAKE_ACCOUNT = 'FAKEACCT00099';
export const FAKE_MERCHANT = 'TEST MERCHANT';

/** A valid static payload (tag 01 = 11). Options let tests break one thing at a time. */
export function buildQr({ initiation = '11', currency = '608', country = 'PH', amount, merchant = FAKE_MERCHANT, account = FAKE_ACCOUNT, badCrc = false } = {}) {
  const parts = [
    tlv('00', '01'),
    tlv('01', initiation),
    tlv('28', tlv('00', 'com.example.fake') + tlv('01', account)),
    tlv('52', '0000'),
  ];
  if (currency) parts.push(tlv('53', currency));
  if (amount) parts.push(tlv('54', amount));
  parts.push(tlv('58', country), tlv('59', merchant), tlv('60', 'TESTVILLE'));
  const body = `${parts.join('')}6304`;
  const crc = crc16(body);
  return `${body}${badCrc ? (crc === '0000' ? '0001' : '0000') : crc}`;
}

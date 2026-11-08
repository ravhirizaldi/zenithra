import sharp from 'sharp';

export type IrfdAttachment = { data: Buffer; name: string; format: string; pageNumber: number };
export type IrfdLocation = { latitude: number; longitude: number; altitude: number };

// FDDocument field 2 contains FDAttachment: bytes=1, name=2, format=3, pageNumber=4.
class ProtoReader {
  offset = 0;
  constructor(readonly data: Buffer) {}
  varint(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.offset >= this.data.length) throw new Error('Truncated protobuf.');
      const byte = this.data[this.offset++];
      if (i === 9 && byte > 1) throw new Error('Invalid protobuf integer.');
      value |= BigInt(byte & 127) << BigInt(i * 7);
      if (byte < 128) return value;
    }
    throw new Error('Invalid protobuf integer.');
  }
  take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.data.length - this.offset)
      throw new Error('Truncated protobuf.');
    const value = this.data.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  bytes() {
    return this.take(Number(this.varint()));
  }
  tag() {
    const tag = Number(this.varint());
    if (tag < 8 || tag > 0xffffffff) throw new Error('Invalid protobuf tag.');
    return { field: Math.floor(tag / 8), wire: tag % 8 };
  }
  skip(field: number, wire: number, depth = 0): void {
    switch (wire) {
      case 0:
        this.varint();
        return;
      case 1:
        this.take(8);
        return;
      case 2:
        this.bytes();
        return;
      case 3:
        if (depth >= 64) throw new Error('Protobuf nesting limit.');
        while (this.offset < this.data.length) {
          const next = this.tag();
          if (next.wire === 4) {
            if (next.field !== field) throw new Error('Invalid protobuf group.');
            return;
          }
          this.skip(next.field, next.wire, depth + 1);
        }
        throw new Error('Truncated protobuf group.');
      case 5:
        this.take(4);
        return;
      default:
        throw new Error('Invalid protobuf wire type.');
    }
  }
}
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
export function irfdAttachments(data: Buffer): IrfdAttachment[] {
  try {
    const document = new ProtoReader(data),
      attachments: IrfdAttachment[] = [];
    while (document.offset < data.length) {
      const tag = document.tag();
      if (tag.field !== 2 || tag.wire !== 2) {
        document.skip(tag.field, tag.wire);
        continue;
      }
      const reader = new ProtoReader(document.bytes());
      const attachment: IrfdAttachment = { data: Buffer.alloc(0), name: '', format: '', pageNumber: 0 };
      while (reader.offset < reader.data.length) {
        const { field, wire } = reader.tag();
        if (wire === 2 && field >= 1 && field <= 3) {
          const bytes = reader.bytes();
          if (field === 1) attachment.data = bytes;
          else if (field === 2) attachment.name = utf8.decode(bytes);
          else attachment.format = utf8.decode(bytes);
        } else if (field === 4 && wire === 0) attachment.pageNumber = Number(BigInt.asIntN(32, reader.varint()));
        else reader.skip(field, wire);
      }
      attachments.push(attachment);
    }
    return attachments;
  } catch {
    // IrfdManager.GetFdDocument returns null on invalid protobuf; its enumerator is empty.
    return [];
  }
}

// GeoTag reads EXIF GPS, including its legacy default altitude=0 and ignored altitude reference.
export function irfdLocation(exif?: Buffer): IrfdLocation | undefined {
  if (!exif) return;
  try {
    const tiff = exif.subarray(exif.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? 6 : 0);
    const little = tiff.toString('ascii', 0, 2) === 'II';
    if (!little && tiff.toString('ascii', 0, 2) !== 'MM') return;
    const u16 = (offset: number) => (little ? tiff.readUInt16LE(offset) : tiff.readUInt16BE(offset));
    const u32 = (offset: number) => (little ? tiff.readUInt32LE(offset) : tiff.readUInt32BE(offset));
    const i32 = (offset: number) => (little ? tiff.readInt32LE(offset) : tiff.readInt32BE(offset));
    if (u16(2) !== 42) return;
    const entries = (offset: number) => {
      const count = u16(offset),
        fields = new Map<number, { type: number; count: number; value: number }>();
      if (offset + 2 + count * 12 > tiff.length) throw new Error('Truncated EXIF.');
      for (let i = 0; i < count; i++) {
        const pos = offset + 2 + i * 12,
          type = u16(pos + 2),
          size = u32(pos + 4);
        fields.set(u16(pos), { type, count: size, value: pos + 8 });
      }
      return fields;
    };
    const pointer = entries(u32(4)).get(0x8825);
    if (!pointer || pointer.type !== 4 || pointer.count !== 1) return;
    const gps = entries(u32(pointer.value));
    const direction = (tag: number) => {
      const entry = gps.get(tag);
      return entry?.type === 2 && entry.count === 2 ? tiff.toString('ascii', entry.value, entry.value + 1) : undefined;
    };
    const rationals = (tag: number, count: number) => {
      const entry = gps.get(tag);
      if (!entry || entry.type !== 5 || entry.count !== count) return;
      const offset = u32(entry.value),
        values = [];
      for (let i = 0; i < count; i++) {
        const value = i32(offset + i * 8) / i32(offset + i * 8 + 4);
        if (!Number.isFinite(value)) return;
        values.push(value);
      }
      return values;
    };
    const lat = rationals(2, 3),
      lon = rationals(4, 3),
      ns = direction(1),
      ew = direction(3);
    if (!lat || !lon || !ns || !ew) return;
    const degrees = (values: number[]) => values[0] + values[1] / 60 + values[2] / 3600;
    return {
      latitude: degrees(lat) * (ns === 'S' ? -1 : 1),
      longitude: degrees(lon) * (ew === 'W' ? -1 : 1),
      altitude: rationals(6, 1)?.[0] ?? 0,
    };
  } catch {
    return;
  } // Invalid EXIF must not hide an otherwise downloadable attachment.
}
export async function irfdImageLocation(data: Buffer) {
  return irfdLocation((await sharp(data).metadata()).exif);
}
export async function irfdImagePreview(data: Buffer): Promise<Buffer> {
  try {
    return await sharp(data)
      .resize(200, 150, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
  } catch {
    return data;
  } // ConMasUtility.ResizeImage returns the original on decoding failure.
}

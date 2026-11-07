//! 最小 STORED（无压缩）zip 打包器：批量导出用。
//! 手写 local file header + central directory + EOCD；CRC32 为标准 IEEE 表驱动。
//! 足够任何标准解压器（unzip/Explorer/Python zipfile）读取。

pub struct ZipEntry {
    pub name: String,
    pub data: Vec<u8>,
}

static CRC_TABLE: std::sync::OnceLock<[u32; 256]> = std::sync::OnceLock::new();

fn crc_table() -> &'static [u32; 256] {
    CRC_TABLE.get_or_init(|| {
        let mut tab = [0u32; 256];
        for (i, slot) in tab.iter_mut().enumerate() {
            let mut c = i as u32;
            for _ in 0..8 {
                c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
            }
            *slot = c;
        }
        tab
    })
}

fn crc32(data: &[u8]) -> u32 {
    // IEEE 802.3 CRC-32（查表法）
    let t = crc_table();
    let mut crc: u32 = 0xFFFF_FFFF;
    for &b in data {
        crc = (crc >> 8) ^ t[((crc ^ b as u32) & 0xFF) as usize];
    }
    crc ^ 0xFFFF_FFFF
}

fn push_u16(v: &mut Vec<u8>, x: u16) {
    v.extend_from_slice(&x.to_le_bytes());
}
fn push_u32(v: &mut Vec<u8>, x: u32) {
    v.extend_from_slice(&x.to_le_bytes());
}

/// 打包为 zip 字节流（STORED，date/time 固定为 1980-01-01——导出物按内容取用）。
pub fn build_zip(entries: &[ZipEntry]) -> Vec<u8> {
    let mut out: Vec<u8> = Vec::new();
    let mut central: Vec<u8> = Vec::new();
    for e in entries {
        let crc = crc32(&e.data);
        let name = e.name.as_bytes();
        let offset = out.len() as u32;
        // local file header
        push_u32(&mut out, 0x0403_4b50);
        push_u16(&mut out, 20); // version needed
        push_u16(&mut out, 0x0800); // UTF-8 names
        push_u16(&mut out, 0); // method: stored
        push_u16(&mut out, 0); // time
        push_u16(&mut out, 0x21); // date: 1980-01-01
        push_u32(&mut out, crc);
        push_u32(&mut out, e.data.len() as u32);
        push_u32(&mut out, e.data.len() as u32);
        push_u16(&mut out, name.len() as u16);
        push_u16(&mut out, 0); // extra len
        out.extend_from_slice(name);
        out.extend_from_slice(&e.data);
        // central directory entry
        push_u32(&mut central, 0x0201_4b50);
        push_u16(&mut central, 20); // version made by
        push_u16(&mut central, 20); // version needed
        push_u16(&mut central, 0x0800);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0);
        push_u16(&mut central, 0x21);
        push_u32(&mut central, crc);
        push_u32(&mut central, e.data.len() as u32);
        push_u32(&mut central, e.data.len() as u32);
        push_u16(&mut central, name.len() as u16);
        push_u16(&mut central, 0); // extra
        push_u16(&mut central, 0); // comment
        push_u16(&mut central, 0); // disk number
        push_u16(&mut central, 0); // internal attrs
        push_u32(&mut central, 0); // external attrs
        push_u32(&mut central, offset);
        central.extend_from_slice(name);
    }
    let cd_offset = out.len() as u32;
    let cd_size = central.len() as u32;
    out.extend_from_slice(&central);
    // EOCD
    push_u32(&mut out, 0x0605_4b50);
    push_u16(&mut out, 0);
    push_u16(&mut out, 0);
    push_u16(&mut out, entries.len() as u16);
    push_u16(&mut out, entries.len() as u16);
    push_u32(&mut out, cd_size);
    push_u32(&mut out, cd_offset);
    push_u16(&mut out, 0);
    out
}

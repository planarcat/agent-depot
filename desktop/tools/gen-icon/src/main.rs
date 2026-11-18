//! Generate the Agent Depot icon source PNG (1024x1024, RGBA).
//!
//! 原 desktop/assets/gen_icon.py 的零依赖 Rust 移植（2026-11-17）：像素逻辑逐行对应
//! （圆角方块 + 三条白药丸、2x 超采样、2x 盒式降采样 alpha 加权）。
//! 唯一差异：IDAT 用 DEFLATE **存储块**（零依赖代价，无压缩；像素与原产物等价，
//! `tauri icon` 只读像素不受影响）。

use std::env;
use std::fs;
use std::io::Write;

const S: usize = 2048; // 2x supersample
const OUT: usize = 1024;
const BG: [u8; 4] = [13, 106, 99, 255]; // #0d6a63 deep teal (product accent)
const FG: [u8; 4] = [249, 250, 250, 255]; // #f9fafa near-white

/// x-span(s) of a rounded rect at row y -> list of (a, b) or []
fn spans_rr(y: f64, x0: f64, y0: f64, x1: f64, y1: f64, r: f64) -> Vec<(f64, f64)> {
    if y < y0 || y > y1 {
        return vec![];
    }
    if y0 + r <= y && y <= y1 - r {
        return vec![(x0, x1)];
    }
    let dy = if y < y0 + r { (y0 + r) - y } else { y - (y1 - r) };
    if dy > r {
        return vec![];
    }
    let half = (r * r - dy * dy).sqrt();
    vec![(x0 + r - half, x1 - r + half)]
}

fn clip_spans(spans: &[(f64, f64)], lo: f64, hi: f64) -> Vec<(f64, f64)> {
    let mut out = vec![];
    for &(a, b) in spans {
        let (a2, b2) = (a.max(lo), b.min(hi));
        if b2 > a2 {
            out.push((a2, b2));
        }
    }
    out
}

fn merge(mut spans: Vec<(f64, f64)>) -> Vec<[f64; 2]> {
    spans.sort_by(|p, q| p.0.total_cmp(&q.0).then(p.1.total_cmp(&q.1)));
    let mut out: Vec<[f64; 2]> = vec![];
    for (a, b) in spans {
        match out.last_mut() {
            Some(last) if a <= last[1] => last[1] = last[1].max(b),
            _ => out.push([a, b]),
        }
    }
    out
}

/// 2x box downsample with alpha-weighted color averaging (correct AA).
fn downsample2x(src: &[u8], s: usize) -> Vec<u8> {
    let w = s / 2;
    let mut out = vec![0u8; w * w * 4];
    for oy in 0..w {
        let r0 = (2 * oy) * s * 4;
        let r1 = r0 + s * 4;
        let orow = oy * w * 4;
        for ox in 0..w {
            let i0 = r0 + ox * 8;
            let i1 = r1 + ox * 8;
            let (a1, a2, a3, a4) = (
                src[i0 + 3] as u32,
                src[i0 + 7] as u32,
                src[i1 + 3] as u32,
                src[i1 + 7] as u32,
            );
            let sa = a1 + a2 + a3 + a4;
            if sa == 0 {
                continue;
            }
            let p = orow + ox * 4;
            out[p] = ((src[i0] as u32 * a1
                + src[i0 + 4] as u32 * a2
                + src[i1] as u32 * a3
                + src[i1 + 4] as u32 * a4)
                / sa) as u8;
            out[p + 1] = ((src[i0 + 1] as u32 * a1
                + src[i0 + 5] as u32 * a2
                + src[i1 + 1] as u32 * a3
                + src[i1 + 5] as u32 * a4)
                / sa) as u8;
            out[p + 2] = ((src[i0 + 2] as u32 * a1
                + src[i0 + 6] as u32 * a2
                + src[i1 + 2] as u32 * a3
                + src[i1 + 6] as u32 * a4)
                / sa) as u8;
            out[p + 3] = (sa / 4) as u8;
        }
    }
    out
}

// ------------------------------------------------------------------ PNG 输出

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (n, slot) in table.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB88320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc = table[((crc ^ b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

fn adler32(data: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in data {
        a = (a + byte as u32) % 65521;
        b = (b + a) % 65521;
    }
    (b << 16) | a
}

fn chunk(out: &mut impl Write, tag: &[u8; 4], data: &[u8]) {
    out.write_all(&(data.len() as u32).to_be_bytes()).unwrap();
    out.write_all(tag).unwrap();
    out.write_all(data).unwrap();
    let mut crc_input = Vec::with_capacity(4 + data.len());
    crc_input.extend_from_slice(tag);
    crc_input.extend_from_slice(data);
    out.write_all(&crc32(&crc_input).to_be_bytes()).unwrap();
}

/// IDAT：zlib 封装（0x78 0x01）+ DEFLATE 存储块（BTYPE=00，无压缩）+ Adler32。
/// 零依赖取舍：文件比 zlib 压缩大，但像素完全等价（合法 PNG）。
fn zlib_stored(raw: &[u8]) -> Vec<u8> {
    let mut out = vec![0x78, 0x01];
    let mut i = 0;
    loop {
        let take = (raw.len() - i).min(65535);
        let last = i + take >= raw.len();
        out.push(if last { 1 } else { 0 }); // BFINAL + BTYPE=00
        out.extend_from_slice(&(take as u16).to_le_bytes());
        out.extend_from_slice(&(!(take as u16)).to_le_bytes());
        out.extend_from_slice(&raw[i..i + take]);
        i += take;
        if last {
            break;
        }
    }
    out.extend_from_slice(&adler32(raw).to_be_bytes());
    out
}

fn write_png(path: &str, w: u32, h: u32, rgba: &[u8]) {
    let mut raw = Vec::with_capacity((w as usize * 4 + 1) * h as usize);
    for y in 0..h as usize {
        raw.push(0u8); // filter: None
        raw.extend_from_slice(&rgba[y * w as usize * 4..(y + 1) * w as usize * 4]);
    }
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 6, 0, 0, 0]); // 8bit, RGBA, deflate, filter, interlace

    let file = fs::File::create(path).expect("创建输出文件失败");
    let mut out = std::io::BufWriter::new(file);
    out.write_all(b"\x89PNG\r\n\x1a\n").unwrap();
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib_stored(&raw));
    chunk(&mut out, b"IEND", b"");
    out.flush().unwrap();
}

fn main() {
    // ---- 光栅化（与原 gen_icon.py 同参）----
    let (m, r) = (0.06, 0.16); // tile margin & corner radius
    let (bar_h, gap) = (0.062, 0.062);
    let widths = [0.46, 0.60, 0.46]; // three pills: narrow / wide / narrow
    let top = 0.5 - (3.0 * bar_h + 2.0 * gap) / 2.0;

    let mut buf = vec![0u8; S * S * 4];
    for py in 0..S {
        let y = (py as f64 + 0.5) / S as f64;
        let row = py * S * 4;
        let tile = merge(clip_spans(&spans_rr(y, m, m, 1.0 - m, 1.0 - m, r), 0.0, 1.0));
        let mut marks = vec![];
        for (i, &wd) in widths.iter().enumerate() {
            let y0 = top + i as f64 * (bar_h + gap);
            marks.extend(clip_spans(
                &spans_rr(y, (1.0 - wd) / 2.0, y0, (1.0 + wd) / 2.0, y0 + bar_h, bar_h / 2.0),
                m,
                1.0 - m,
            ));
        }
        let marks = merge(marks);
        let mut rowbuf = vec![0u8; S * 4];
        for &[a, b] in &tile {
            for x in (a * S as f64) as usize..(b * S as f64) as usize {
                rowbuf[x * 4..x * 4 + 4].copy_from_slice(&BG);
            }
        }
        for &[a, b] in &marks {
            for x in (a * S as f64) as usize..(b * S as f64) as usize {
                rowbuf[x * 4..x * 4 + 4].copy_from_slice(&FG);
            }
        }
        buf[row..row + S * 4].copy_from_slice(&rowbuf);
    }

    let img = downsample2x(&buf, S);
    let path = env::args().nth(1).unwrap_or_else(|| "icon-source.png".into());
    write_png(&path, OUT as u32, OUT as u32, &img);
    println!("icon source written: {path}");
}

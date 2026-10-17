#!/usr/bin/env python3
"""屏幕像素分析工具（不依赖 Pillow，纯标准库）。

用途：把 adb 截屏 PNG 解码成裸像素，然后按行/列扫描颜色，用来**精确**定位
界面元素。目测截图坐标是最容易出错的一步（Read 显示会缩放，比例全靠猜），
所以坐标一律从像素里算出来。

用法：
  pix.py info  a.png                     # 尺寸/格式
  pix.py rows  a.png --x 600 --x2 900    # 在 x..x2 之间逐行取样，打印颜色突变行
  pix.py crop  a.png out.png --y0 700 --y1 2300   # 裁切（保留原分辨率）
"""
import sys
import zlib
import struct


def decode_png(path):
    d = open(path, 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n', 'not png'
    pos = 8
    w = h = bit = ctype = None
    idat = bytearray()
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        data = d[pos + 8:pos + 8 + ln]
        if typ == b'IHDR':
            w, h, bit, ctype = struct.unpack('>IIBB', data[:10])
        elif typ == b'IDAT':
            idat += data
        elif typ == b'IEND':
            break
        pos += 12 + ln
    raw = zlib.decompress(bytes(idat))
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ctype]
    assert bit == 8, 'only 8-bit supported, got %d' % bit
    bpp = ch
    stride = w * ch
    out = bytearray(stride * h)
    prev = bytearray(stride)
    p = 0
    for y in range(h):
        f = raw[p]; p += 1
        line = bytearray(raw[p:p + stride]); p += stride
        if f == 1:
            for i in range(bpp, stride):
                line[i] = (line[i] + line[i - bpp]) & 0xFF
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif f == 3:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xFF
        elif f == 4:
            for i in range(stride):
                a = line[i - bpp] if i >= bpp else 0
                b = prev[i]
                c = prev[i - bpp] if i >= bpp else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out[y * stride:(y + 1) * stride] = line
        prev = line
    return w, h, ch, out


def px(buf, w, ch, x, y):
    i = (y * w + x) * ch
    return buf[i], buf[i + 1], buf[i + 2]


def cmd_info(a):
    w, h, ch, _ = decode_png(a)
    print('size %dx%d channels %d' % (w, h, ch))


def cmd_rows(a, x, x2):
    w, h, ch, buf = decode_png(a)
    if x2 <= x:
        x2 = x
    print('scan x=[%d,%d] over %d rows' % (x, x2, h))
    last = None
    for y in range(h):
        # 取这段里最暗的像素代表这一行（横线是细的，用最暗值才抓得到）
        best = None
        for xx in (x, (x + x2) // 2, x2):
            r, g, b = px(buf, w, ch, xx, y)
            lum = (r * 299 + g * 587 + b * 114) // 1000
            if best is None or lum < best[0]:
                best = (lum, r, g, b)
        if last is None or abs(best[0] - last) > 8:
            print('y=%4d lum=%3d rgb=(%3d,%3d,%3d)' % (y, best[0], best[1], best[2], best[3]))
        last = best[0]


def cmd_cols(a, y, y2):
    w, h, ch, buf = decode_png(a)
    if y2 <= y:
        y2 = y
    print('scan y=[%d,%d] over %d cols' % (y, y2, w))
    last = None
    for x in range(w):
        best = None
        for yy in (y, (y + y2) // 2, y2):
            r, g, b = px(buf, w, ch, x, yy)
            lum = (r * 299 + g * 587 + b * 114) // 1000
            if best is None or lum < best[0]:
                best = (lum, r, g, b)
        if last is None or abs(best[0] - last) > 8:
            print('x=%4d lum=%3d rgb=(%3d,%3d,%3d)' % (x, best[0], best[1], best[2], best[3]))
        last = best[0]


def cmd_crop(a, out, y0, y1):
    w, h, ch, buf = decode_png(a)
    y0 = max(0, y0); y1 = min(h, y1)
    hh = y1 - y0
    rows = bytearray()
    for y in range(y0, y1):
        rows += b'\x00' + bytes(buf[y * w * ch:(y + 1) * w * ch])

    def chunk(t, data):
        c = t + data
        return struct.pack('>I', len(data)) + c + struct.pack('>I', zlib.crc32(c) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, hh, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(rows), 6))
           + chunk(b'IEND', b''))
    open(out, 'wb').write(png)
    print('cropped y[%d,%d] -> %s (%dx%d)' % (y0, y1, out, w, hh))


def main():
    c = sys.argv[1]
    if c == 'info':
        cmd_info(sys.argv[2])
    elif c == 'rows':
        x = x2 = None
        y0 = y1 = None
        args = sys.argv[3:]
        i = 0
        while i < len(args):
            if args[i] == '--x':
                x = int(args[i + 1]); i += 2
            elif args[i] == '--x2':
                x2 = int(args[i + 1]); i += 2
            else:
                i += 1
        cmd_rows(sys.argv[2], x if x is not None else 300, x2 if x2 is not None else 800)
    elif c == 'cols':
        y = y2 = None
        args = sys.argv[3:]
        i = 0
        while i < len(args):
            if args[i] == '--y':
                y = int(args[i + 1]); i += 2
            elif args[i] == '--y2':
                y2 = int(args[i + 1]); i += 2
            else:
                i += 1
        cmd_cols(sys.argv[2], y if y is not None else 400, y2 if y2 is not None else 1200)
    elif c == 'crop':
        out = sys.argv[3]
        y0 = y1 = None
        args = sys.argv[4:]
        i = 0
        while i < len(args):
            if args[i] == '--y0':
                y0 = int(args[i + 1]); i += 2
            elif args[i] == '--y1':
                y1 = int(args[i + 1]); i += 2
            else:
                i += 1
        cmd_crop(sys.argv[2], out, y0 or 0, y1 or 3000)
    else:
        print(__doc__)


if __name__ == '__main__':
    main()

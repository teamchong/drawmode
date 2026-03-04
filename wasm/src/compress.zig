const std = @import("std");

/// Compress data using zlib stored-block format.
/// Produces valid zlib output (RFC 1950) with uncompressed deflate stored blocks (RFC 1951).
/// pako.inflate / browser inflate can decompress this.
///
/// Format:
///   [2-byte zlib header] [stored blocks...] [4-byte Adler-32 big-endian]
///
/// Each stored block:
///   [1-byte flags: BFINAL|BTYPE=00] [2-byte LEN LE] [2-byte NLEN LE] [data]
pub fn zlibCompress(input: []const u8, out: []u8) !usize {
    // Worst case: 2 (header) + ceil(input.len/65535) * (5 + 65535) + 4 (checksum)
    const max_blocks = if (input.len == 0) 1 else (input.len + 65534) / 65535;
    const needed = 2 + max_blocks * 5 + input.len + 4;
    if (out.len < needed) return error.NoSpaceLeft;

    var pos: usize = 0;

    // Zlib header: CMF=0x78 (CM=8 deflate, CINFO=7 window), FLG=0x01 (FCHECK so CMF*256+FLG % 31 == 0)
    out[pos] = 0x78;
    pos += 1;
    out[pos] = 0x01;
    pos += 1;

    // Write stored blocks (max 65535 bytes each)
    var offset: usize = 0;
    while (true) {
        const remaining = input.len - offset;
        const block_len: u16 = @intCast(@min(remaining, 65535));
        const is_final = offset + block_len >= input.len;

        // Block header: BFINAL (1 bit) | BTYPE=00 (2 bits) = 0x00 or 0x01
        out[pos] = if (is_final) 0x01 else 0x00;
        pos += 1;

        // LEN (little-endian)
        std.mem.writeInt(u16, out[pos..][0..2], block_len, .little);
        pos += 2;

        // NLEN (one's complement of LEN, little-endian)
        std.mem.writeInt(u16, out[pos..][0..2], ~block_len, .little);
        pos += 2;

        // Data
        @memcpy(out[pos..][0..block_len], input[offset..][0..block_len]);
        pos += block_len;
        offset += block_len;

        if (is_final) break;
    }

    // Adler-32 checksum (big-endian)
    const checksum = adler32(input);
    std.mem.writeInt(u32, out[pos..][0..4], checksum, .big);
    pos += 4;

    return pos;
}

fn adler32(data: []const u8) u32 {
    const MOD_ADLER: u32 = 65521;
    var a: u32 = 1;
    var b: u32 = 0;
    for (data) |byte| {
        a = (a + byte) % MOD_ADLER;
        b = (b + a) % MOD_ADLER;
    }
    return (b << 16) | a;
}

test "zlibCompress produces valid zlib data" {
    const input = "Hello, Excalidraw!";
    var compressed: [4096]u8 = undefined;
    const comp_len = try zlibCompress(input, &compressed);
    try std.testing.expect(comp_len > 0);
    // Verify zlib header
    try std.testing.expectEqual(@as(u8, 0x78), compressed[0]);
    try std.testing.expectEqual(@as(u8, 0x01), compressed[1]);
    // Verify stored block header: BFINAL=1, BTYPE=00
    try std.testing.expectEqual(@as(u8, 0x01), compressed[2]);
    // Verify LEN
    try std.testing.expectEqual(@as(u16, 18), std.mem.readInt(u16, compressed[3..5], .little));
}

test "zlibCompress empty input" {
    var compressed: [64]u8 = undefined;
    const comp_len = try zlibCompress("", &compressed);
    // Header(2) + block header(5) + data(0) + checksum(4) = 11
    try std.testing.expectEqual(@as(usize, 11), comp_len);
    try std.testing.expectEqual(@as(u8, 0x78), compressed[0]);
}

# -*- coding: utf-8 -*-
"""
Create the ZSEARCH desktop shortcut by writing a .lnk file directly.

Why not WScript.Shell: COM instantiation is blocked in this environment, so the
usual `CreateShortcut` route is unavailable. The Shell Link Binary File Format
(MS-SHLLINK) is a documented, stable structure, so the shortcut is assembled
byte by byte here instead -- and then parsed back so the result is verified
rather than assumed.

The one field that matters more than all the others is the LinkTargetIDList.
An earlier version of this script left it out and leaned on LinkInfo + a
RELATIVE_PATH holding an absolute path: the file parsed fine by our own reader
and looked right on disk, but Windows refused to open it --
"没有应用程序与此操作的指定文件有关联" (ERROR_NO_ASSOCIATION). The shell
binds a shortcut through the IDList first; without one there is nothing to
bind. Structure of a working Windows-made .lnk, for reference:

    IDList: [0x1F My Computer, 20B][0x2F volume "E:\\", 25B]
            [0x35 folder, unicode name][0x32 file, 8.3 name]
    VolumeID: real drive serial number
    strings: NAME, WORKING_DIR, ICON_LOCATION (no RELATIVE_PATH)

0x32 vs 0x35 is not file-vs-folder -- it is "has an 8.3 short name" vs "unicode
name only". The volume here has 8.3 generation off (CIM_DataFile reports the
EightDotThreeFileName equal to the long name), so every item is built as 0x35
with the real directory/file flag carried in the attributes field instead.

Usage: python _mklnk.py [target] [workdir] [icon] [out.lnk]
"""
import ctypes
import os
import struct
import sys
import time

TARGET = r"E:\网盘\zsearch\启动.bat"
WORKDIR = r"E:\网盘\zsearch"
ICON = r"E:\网盘\zsearch\public\static\zsearch.ico"
NAME = "ZSEARCH 瞬时搜"
DESKTOP_LNK = "ZSEARCH.lnk"

ANSI_CP = "gbk"          # system codepage on a Chinese Windows install

# {00021401-0000-0000-C000-000000000046}
CLSID_SHORTCUT = bytes([
    0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
])

HAS_ID_LIST = 0x00000001
HAS_LINK_INFO = 0x00000002
HAS_NAME = 0x00000004
HAS_RELATIVE_PATH = 0x00000008
HAS_WORKING_DIR = 0x00000010
HAS_ICON_LOCATION = 0x00000040
IS_UNICODE = 0x00000080

FILE_ATTRIBUTE_ARCHIVE = 0x00000020
FILE_ATTRIBUTE_DIRECTORY = 0x00000010
SW_SHOWNORMAL = 1
DRIVE_FIXED = 3

# Shell item building blocks, taken verbatim from a Windows-made .lnk so the
# parts Windows does not re-derive (GUIDs, fixed padding) are byte-identical.
ITEM_MY_COMPUTER = bytes.fromhex(
    "1400" "1f50" "e04fd020ea3a6910a2d808002b30309d")
ITEM_VOLUME_E = bytes.fromhex("1900" "2f" "453a5c00" + "00" * 18)   # "E:\"
# The 38 bytes between the extension header and the name: timestamps plus a
# name offset (46) at +0x10. Constants that the shell does not validate.
ITEM_META = bytes.fromhex("035de16e295da81a"
                          "2e000000" "ffb80000" "00003901"
                          "00000000" "00000000" "00000000"
                          "0000273b7100")
EXT_VERSION = 9
EXT_SIGNATURE = 0xBEEF0004
EXT_NAME_OFFSET = 46          # 2 (size) + 6 (version+sig) + 38 (metadata)

# The file-entry class type byte is not simply "0x35 = unicode name only": that
# value is what Windows writes for a DIRECTORY. A file with no 8.3 name needs
# its own value. Overridable so variants can be probed without editing code.
DIR_TYPE = int(os.environ.get("ZS_DIR_TYPE", "0x35"), 16)
FILE_TYPE = int(os.environ.get("ZS_FILE_TYPE", "0x33"), 16)


def u16(v):
    return struct.pack("<H", v)


def u32(v):
    return struct.pack("<I", v)


def ansi_z(s):
    return s.encode(ANSI_CP, errors="replace") + b"\x00"


def uni_z(s):
    return s.encode("utf-16-le") + b"\x00\x00"


def string_data(s, unicode_flag):
    """StringData: 2-byte character count, then the characters."""
    body = uni_z(s) if unicode_flag else ansi_z(s)
    count = len(body) // 2 if unicode_flag else len(body)
    return u16(count) + body


def volume_info(root):
    """(serial, label) of the volume holding `root`, straight from Win32.

    Hard-coding the serial would rot the moment the drive is replaced, and a
    wrong serial makes Windows distrust LinkInfo.
    """
    label_buf = ctypes.create_unicode_buffer(261)
    serial = ctypes.c_uint32()
    ok = ctypes.windll.kernel32.GetVolumeInformationW(
        ctypes.c_wchar_p(root), label_buf, 261, ctypes.byref(serial),
        None, None, None, 0)
    if not ok:
        raise SystemExit("GetVolumeInformationW failed for %s" % root)
    return serial.value, label_buf.value


def dos_datetime(path):
    """FAT date/time, as the 4 bytes a file-entry shell item carries."""
    t = time.localtime(os.stat(path).st_mtime)
    date = ((t.tm_year - 1980) << 9) | (t.tm_mon << 5) | t.tm_mday
    tim = (t.tm_hour << 11) | (t.tm_min << 5) | (t.tm_sec // 2)
    return struct.pack("<HH", date, tim)


def item_named(path, name):
    """One shell item for `name`, in the unicode-only form."""
    is_dir = os.path.isdir(path)
    nm = uni_z(name)
    head = (bytes([(DIR_TYPE if is_dir else FILE_TYPE), 0x00])
            + u32(0 if is_dir else os.path.getsize(path))
            + dos_datetime(path)
            + u16(FILE_ATTRIBUTE_DIRECTORY if is_dir else FILE_ATTRIBUTE_ARCHIVE))
    ext_offset = len(head) + 2 + len(nm)          # +2 for this item's own cb
    ext = (u16(EXT_NAME_OFFSET + len(nm) + 2)     # block size
           + u16(EXT_VERSION)
           + u32(EXT_SIGNATURE)
           + ITEM_META
           + nm
           + u16(ext_offset))
    return u16(ext_offset + len(ext)) + head + nm + ext


def build_id_list(target):
    """Desktop-rooted IDList: My Computer -> volume -> folders -> file."""
    drive, tail = os.path.splitdrive(os.path.abspath(target))
    root = drive + "\\"
    if root.upper() != "E:\\":
        raise SystemExit("only the E: volume item is baked in, got %s" % root)
    parts = [p for p in tail.split("\\") if p]
    items = [ITEM_MY_COMPUTER, ITEM_VOLUME_E]
    walk = root
    for p in parts:
        walk = os.path.join(walk, p)
        items.append(item_named(walk, p))
    body = b"".join(items) + b"\x00\x00"
    return u16(len(body)) + body


def build_link_info(target):
    """LinkInfo, carrying the target's absolute path."""
    serial, label = volume_info(os.path.splitdrive(os.path.abspath(target))[0] + "\\")

    volume_id = u32(0) + u32(DRIVE_FIXED) + u32(serial) + u32(0x10) + ansi_z(label)
    volume_id = u32(len(volume_id)) + volume_id[4:]

    local_base = ansi_z(target)
    common_suffix = ansi_z("")            # empty: LocalBasePath holds the whole path

    header_size = 0x1C                    # 7 x 4-byte fields
    vol_off = header_size
    base_off = vol_off + len(volume_id)
    cps_off = base_off + len(local_base)
    total = cps_off + len(common_suffix)

    header = (
        u32(total) + u32(header_size) + u32(0x00000001)   # VolumeIDAndLocalBasePath
        + u32(vol_off) + u32(base_off) + u32(0) + u32(cps_off)
    )
    return header + volume_id + local_base + common_suffix


def build_lnk(target, workdir, icon):
    # No HAS_RELATIVE_PATH: Windows-made shortcuts to a same-drive file leave it
    # out, and stuffing an absolute path in there (as an earlier version did)
    # is not what the field means.
    flags = (HAS_ID_LIST | HAS_LINK_INFO | HAS_NAME
             | HAS_WORKING_DIR | HAS_ICON_LOCATION | IS_UNICODE)

    header = (
        u32(0x4C)                         # HeaderSize = 76
        + CLSID_SHORTCUT                  # LinkCLSID
        + u32(flags)                      # LinkFlags
        + u32(FILE_ATTRIBUTE_ARCHIVE)     # FileAttributes
        + struct.pack("<Q", 0)            # CreationTime
        + struct.pack("<Q", 0)            # AccessTime
        + struct.pack("<Q", 0)            # WriteTime
        + u32(0)                          # FileSize
        + u32(0)                          # IconIndex
        + u32(SW_SHOWNORMAL)              # ShowCommand
        + u16(0)                          # HotKey
        + u16(0)                          # Reserved1
        + u32(0)                          # Reserved2
        + u32(0)                          # Reserved3
    )
    assert len(header) == 76, "header must be 76 bytes, got %d" % len(header)

    # StringData blocks, in the order the flags declare them.
    data = (string_data(NAME, True) + string_data(workdir, True)
            + string_data(icon, True))

    return header + build_id_list(target) + build_link_info(target) + data + u32(0)


def walk_id_list(buf, off):
    """Read the IDList back: (items,end) where each item is (size,type,name)."""
    n, = struct.unpack_from("<H", buf, off)
    p = off + 2
    end = p + n
    items = []
    while p < end - 1:
        cb, = struct.unpack_from("<H", buf, p)
        if cb == 0:
            break
        it = buf[p:p + cb]
        kind = it[2] if len(it) > 2 else 0
        name = ""
        # In the unicode-inline forms (bit 0 set: 0x31/0x33/0x35) the name
        # follows the 14-byte header directly, so read it there -- locating it
        # via the extension signature is easy to get one byte off.
        if kind & 0x01:
            # Scan on even offsets only: a name whose last char ends in 0x00
            # (every ASCII one does) is followed by the 00 00 terminator, so a
            # plain find() lands one byte early and loses the final character.
            stop = -1
            for q in range(14, cb - 1, 2):
                if it[q:q + 2] == b"\x00\x00":
                    stop = q
                    break
            if stop > 14:
                name = it[14:stop].decode("utf-16-le", "replace")
        items.append((cb, kind, name))
        p += cb
    return items, end


def parse(buf):
    """Read the file back so the result is verified, not assumed."""
    out = {}
    out["headerSize"] = struct.unpack_from("<I", buf, 0)[0]
    out["clsid"] = buf[4:20].hex()
    flags = struct.unpack_from("<I", buf, 20)[0]
    out["flags"] = "0x%08X" % flags
    out["fileAttributes"] = "0x%08X" % struct.unpack_from("<I", buf, 24)[0]
    out["showCommand"] = struct.unpack_from("<I", buf, 60)[0]

    off = 76
    if flags & HAS_ID_LIST:
        items, off = walk_id_list(buf, off)
        out["idList"] = items
    else:
        out["idList"] = None

    if flags & HAS_LINK_INFO:
        li_size, li_hdr = struct.unpack_from("<II", buf, off)
        li_flags, vol_off, base_off, cnrl_off, cps_off = struct.unpack_from(
            "<IIIII", buf, off + 8)
        out["linkInfoSize"] = li_size
        out["linkInfoHeaderSize"] = li_hdr
        out["linkInfoFlags"] = "0x%08X" % li_flags
        out["driveType"] = struct.unpack_from("<I", buf, off + vol_off + 4)[0]
        out["volumeSerial"] = "0x%08X" % struct.unpack_from(
            "<I", buf, off + vol_off + 8)[0]
        raw_base = buf[off + base_off:off + cps_off]
        out["localBasePath"] = decode_z(raw_base, False)
        out["commonPathSuffix"] = repr(
            buf[off + cps_off:off + li_size].split(b"\x00")[0])
        off += li_size

    uni = bool(flags & IS_UNICODE)
    for bit, name in ((HAS_NAME, "name"), (HAS_RELATIVE_PATH, "relativePath"),
                      (HAS_WORKING_DIR, "workingDir"),
                      (HAS_ICON_LOCATION, "iconLocation")):
        if not (flags & bit):
            continue
        cnt = struct.unpack_from("<H", buf, off)[0]
        off += 2
        raw = buf[off:off + cnt * 2] if uni else buf[off:off + cnt]
        off += cnt * 2 if uni else cnt
        out[name] = decode_z(raw, uni)
    out["trailingBytes"] = len(buf) - off   # should be 4: the ExtraData terminator
    return out


def decode_z(raw, unicode_flag):
    """Strip the string's own terminator, then decode.

    The character count in StringData INCLUDES the terminating null, so the
    terminator is always the final 2 (Unicode) or 1 (ANSI) bytes. Slicing on a
    b'\\x00\\x00' pattern instead would mis-hit whenever two adjacent bytes
    happen to be zero, which is exactly what broke the first parse attempt.
    """
    if unicode_flag:
        assert len(raw) % 2 == 0, "odd byte count for a Unicode string"
        body = raw[:-2]
        return body.decode("utf-16-le", errors="replace")
    return raw[:-1].decode(ANSI_CP, errors="replace")


def preflight(target, workdir, icon):
    """A shortcut to a missing target is a silent failure -- check first."""
    problems = []
    if not os.path.isfile(target):
        problems.append("target not found: %s" % target)
    if not os.path.isdir(workdir):
        problems.append("working dir not found: %s" % workdir)
    if icon:
        if not os.path.isfile(icon):
            problems.append("icon not found: %s" % icon)
        elif os.path.getsize(icon) == 0:
            problems.append("icon is empty: %s" % icon)
    for p in problems:
        print("  !! " + p)
    return not problems


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else TARGET
    workdir = sys.argv[2] if len(sys.argv) > 2 else WORKDIR
    icon = sys.argv[3] if len(sys.argv) > 3 else ICON
    out_path = sys.argv[4] if len(sys.argv) > 4 else os.path.join(
        os.path.join(os.path.expanduser("~"), "Desktop"), DESKTOP_LNK)

    print("preflight:")
    print("  target   %s  (%d B)" % (target, os.path.getsize(target)
                                     if os.path.isfile(target) else -1))
    print("  workdir  %s" % workdir)
    print("  icon     %s  (%d B)" % (icon, os.path.getsize(icon)
                                     if icon and os.path.isfile(icon) else -1))
    if not preflight(target, workdir, icon):
        print("\naborted: fix the paths above before writing the shortcut.")
        return 2

    lnk = build_lnk(target, workdir, icon)
    with open(out_path, "wb") as f:
        f.write(lnk)

    print("\nwrote %s (%d bytes)" % (out_path, len(lnk)))
    with open(out_path, "rb") as f:
        parsed = parse(f.read())
    print("\n--- parsed back ---")
    print("  %-20s %s" % ("headerSize", parsed["headerSize"]))
    print("  %-20s %s" % ("flags", parsed["flags"]))
    print("  %-20s %s" % ("fileAttributes", parsed["fileAttributes"]))
    print("  %-20s %s" % ("volumeSerial", parsed.get("volumeSerial")))
    print("  %-20s %s" % ("localBasePath", parsed["localBasePath"]))
    print("  %-20s %s" % ("name", parsed.get("name")))
    print("  %-20s %s" % ("workingDir", parsed["workingDir"]))
    print("  %-20s %s" % ("iconLocation", parsed.get("iconLocation")))
    print("  %-20s %s" % ("trailingBytes", parsed["trailingBytes"]))
    print("  IDList:")
    for cb, kind, name in parsed["idList"] or []:
        print("      size=%-4d type=0x%02X  %s" % (cb, kind, name or "(no name)"))

    ok = (parsed["headerSize"] == 76
          and parsed["idList"] is not None
          and len(parsed["idList"]) >= 4
          and parsed["workingDir"] == workdir
          and parsed["iconLocation"] == icon
          and parsed["localBasePath"] == target
          and parsed["driveType"] == DRIVE_FIXED
          and parsed["trailingBytes"] == 4)
    print("\nverify: %s" % ("OK" if ok else "MISMATCH"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

/*
  lnk.js
  a from-scratch encoder and decoder for the windows shell link binary file
  format. no dependencies. every field is written by hand, little-endian, per
  the ms-shllink layout: shell link header, optional link-target id list,
  link info, string data, extra data.

  public surface:
    Lnk.build(spec)   -> uint8array, a valid .lnk file
    Lnk.decode(bytes) -> plain object describing an existing .lnk
    plus small path helpers.
*/

(function (root) {
  "use strict";

  /* ---- link flags ---- */
  var F_HAS_LINK_TARGET_IDLIST = 0x00000001;
  var F_HAS_LINK_INFO          = 0x00000002;
  var F_HAS_NAME               = 0x00000004;
  var F_HAS_RELATIVE_PATH      = 0x00000008;
  var F_HAS_WORKING_DIR        = 0x00000010;
  var F_HAS_ARGUMENTS          = 0x00000020;
  var F_HAS_ICON_LOCATION      = 0x00000040;
  var F_IS_UNICODE             = 0x00000080;
  /* the elevation hint. explorer honours the 0x2000 bit as "run as admin". */
  var F_RUN_AS_USER            = 0x00002000;

  /* ---- file attributes ---- */
  var FA_ARCHIVE   = 0x00000020;
  var FA_DIRECTORY = 0x00000010;

  /* ---- link info flags ---- */
  var LI_VOLUMEID_AND_LOCAL_BASE_PATH = 0x00000001;

  /* ---- drive type ---- */
  var DRIVE_FIXED = 3;

  /* ---- shell item type bytes ---- */
  var IT_ROOT   = 0x1f;   /* clsid root (my computer) */
  var IT_VOLUME = 0x2f;   /* a drive */
  var IT_DIR    = 0x31;   /* folder */
  var IT_FILE   = 0x32;   /* file */

  /* the "beef" file-entry extension signature */
  var BEEF = 0xbeef0004;

  /* my computer clsid, groups little-endian then trailing bytes as-is */
  var MYCOMPUTER_CLSID = [
    0xe0, 0x4f, 0xd0, 0x20, 0xea, 0x3a, 0x69, 0x10,
    0xa2, 0xd8, 0x08, 0x00, 0x2b, 0x30, 0x30, 0x9d
  ];

  /* growable little-endian byte buffer */
  function ByteBuf() { this.b = []; }
  ByteBuf.prototype.u8 = function (v) { this.b.push(v & 0xff); return this; };
  ByteBuf.prototype.u16 = function (v) { this.u8(v); this.u8(v >>> 8); return this; };
  ByteBuf.prototype.u32 = function (v) {
    this.u8(v); this.u8(v >>> 8); this.u8(v >>> 16); this.u8(v >>> 24);
    return this;
  };
  ByteBuf.prototype.raw = function (arr) {
    for (var i = 0; i < arr.length; i++) this.b.push(arr[i] & 0xff);
    return this;
  };
  /* ansi bytes, one per char, unrepresentable code points fall back to '?' */
  ByteBuf.prototype.ansi = function (s) {
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      this.u8(c > 0xff ? 0x3f : c);
    }
    return this;
  };
  ByteBuf.prototype.ansiz = function (s) { this.ansi(s); this.u8(0); return this; };
  /* utf-16le code units */
  ByteBuf.prototype.utf16 = function (s) {
    for (var i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this;
  };
  ByteBuf.prototype.utf16z = function (s) { this.utf16(s); this.u16(0); return this; };
  Object.defineProperty(ByteBuf.prototype, "length", {
    get: function () { return this.b.length; }
  });
  ByteBuf.prototype.bytes = function () { return new Uint8Array(this.b); };

  function ansiByteLength(s) { return s.length; }

  function concat(chunks) {
    var total = 0, i;
    for (i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var pos = 0;
    for (i = 0; i < chunks.length; i++) {
      out.set(chunks[i], pos);
      pos += chunks[i].length;
    }
    return out;
  }

  function directoryOf(path) {
    var cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    return cut > 0 ? path.slice(0, cut) : "";
  }
  function baseNameOf(path) {
    var cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
    return cut >= 0 ? path.slice(cut + 1) : path;
  }

  /* split a drive-rooted path into { drive:"c:", parts:[...] } or null */
  function splitDrivePath(path) {
    var m = /^([a-zA-Z]):[\\\/](.*)$/.exec(path);
    if (!m) return null;
    var rest = m[2];
    var parts = rest.split(/[\\\/]+/).filter(function (p) { return p.length > 0; });
    return { drive: m[1].toLowerCase() + ":", parts: parts };
  }

  /*
    shell link header: fixed 76 (0x4c) bytes.
    clsid 00021401-0000-0000-c000-000000000046.
  */
  function writeHeader(spec, flags, fileAttrs) {
    var b = new ByteBuf();
    b.u32(0x0000004c);
    b.raw([0x01, 0x14, 0x02, 0x00,
           0x00, 0x00,
           0x00, 0x00,
           0xc0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]);
    b.u32(flags >>> 0);
    b.u32(fileAttrs >>> 0);
    b.u32(0).u32(0);      /* creation time unset */
    b.u32(0).u32(0);      /* access time unset */
    b.u32(0).u32(0);      /* write time unset */
    b.u32(0);             /* file size */
    b.u32(spec.iconIndex | 0);
    b.u32(spec.showCommand | 0);
    b.u16(spec.hotkey & 0xffff);
    b.u16(0);             /* reserved1 */
    b.u32(0);             /* reserved2 */
    b.u32(0);             /* reserved3 */
    return b.bytes();
  }

  /* one shell item: cb (includes itself) then data bytes */
  function itemFromData(dataBytes) {
    var b = new ByteBuf();
    b.u16(2 + dataBytes.length);
    b.raw(dataBytes);
    return b.bytes();
  }

  /* root "my computer" item */
  function rootItem() {
    var d = new ByteBuf();
    d.u8(IT_ROOT).u8(0x50).raw(MYCOMPUTER_CLSID);
    return itemFromData(d.bytes());
  }

  /* drive item, e.g. "c:\" -> padded to the classic 25-byte shell item */
  function driveItem(drive) {
    var d = new ByteBuf();
    d.u8(IT_VOLUME).ansiz(drive + "\\");
    while (d.length < 23) d.u8(0);   /* 23 data bytes + 2 cb = 25 (0x19) */
    return itemFromData(d.bytes());
  }

  /*
    file / folder item with a trailing beef-0004 extension holding the unicode
    long name. all embedded times are left zero (unset).
  */
  function fileItem(name, isDir) {
    var pre = new ByteBuf();
    pre.u8(isDir ? IT_DIR : IT_FILE);
    pre.u8(0);                                   /* unknown */
    pre.u32(0);                                  /* file size */
    pre.u16(0).u16(0);                           /* mod date / time */
    pre.u16(isDir ? FA_DIRECTORY : FA_ARCHIVE);  /* attributes */
    pre.ansiz(name);
    /* pad so the extension begins on an even offset from the item start */
    if ((2 + pre.length) % 2 !== 0) pre.u8(0);

    var versionOffset = 2 + pre.length + 2;      /* offset to the version field */

    var body = new ByteBuf();
    body.u16(0x0003);          /* extension version */
    body.u32(BEEF);            /* signature */
    body.u16(0).u16(0);        /* creation date / time */
    body.u16(0).u16(0);        /* access date / time */
    body.u16(0);               /* unknown */
    body.utf16z(name);         /* unicode long name */
    body.u16(versionOffset);   /* first-extension version offset */

    var ext = new ByteBuf();
    ext.u16(2 + body.length);  /* extension block size, includes this field */
    ext.raw(body.bytes());

    return itemFromData(concat([pre.bytes(), ext.bytes()]));
  }

  /*
    build a link-target id list from a drive-rooted path. returns the id list
    payload (items + terminator) or null when the path is not drive-rooted.
  */
  function buildIdList(path, targetIsDir) {
    var split = splitDrivePath(path);
    if (!split) return null;

    var items = [rootItem(), driveItem(split.drive)];
    var parts = split.parts;
    for (var i = 0; i < parts.length; i++) {
      var last = (i === parts.length - 1);
      var asDir = last ? !!targetIsDir : true;
      items.push(fileItem(parts[i], asDir));
    }
    var term = new ByteBuf().u16(0).bytes();
    items.push(term);
    return concat(items);
  }

  /*
    link info with an inline volume id and both ansi + unicode local base
    paths. header size is 0x24 because the unicode offsets are present.
  */
  function writeLinkInfo(path) {
    var HEADER_SIZE = 0x24;

    var volLabel = "";
    var volIdSize = 16 + ansiByteLength(volLabel) + 1;

    var ansiPathLen = ansiByteLength(path) + 1;
    var suffixAnsiLen = 1;
    var uniPathLen = (path.length + 1) * 2;
    var suffixUniLen = 2;

    var volumeIdOffset = HEADER_SIZE;
    var localBasePathOffset = volumeIdOffset + volIdSize;
    var commonPathSuffixOffset = localBasePathOffset + ansiPathLen;
    var localBasePathUnicodeOffset = commonPathSuffixOffset + suffixAnsiLen;
    var commonPathSuffixUnicodeOffset = localBasePathUnicodeOffset + uniPathLen;
    var linkInfoSize = commonPathSuffixUnicodeOffset + suffixUniLen;

    var b = new ByteBuf();
    b.u32(linkInfoSize);
    b.u32(HEADER_SIZE);
    b.u32(LI_VOLUMEID_AND_LOCAL_BASE_PATH);
    b.u32(volumeIdOffset);
    b.u32(localBasePathOffset);
    b.u32(0);                               /* common network relative link */
    b.u32(commonPathSuffixOffset);
    b.u32(localBasePathUnicodeOffset);
    b.u32(commonPathSuffixUnicodeOffset);

    b.u32(volIdSize);
    b.u32(DRIVE_FIXED);
    b.u32(0);                               /* serial */
    b.u32(0x00000010);                      /* volume label offset */
    b.ansiz(volLabel);

    b.ansiz(path);
    b.u8(0);

    b.utf16z(path);
    b.u16(0);

    return b.bytes();
  }

  /* one string-data entry: 16-bit character count then utf-16le chars */
  function writeUnicodeString(s) {
    var b = new ByteBuf();
    b.u16(s.length & 0xffff);
    b.utf16(s);
    return b.bytes();
  }

  /*
    spec fields (all optional except target):
      target        absolute path the shortcut resolves to   (required)
      arguments     command line string
      workingDir    start-in directory (derived if omitted)
      description   name / tooltip string
      iconPath      file that holds the icon
      iconIndex     integer index inside iconPath
      showCommand   1 normal, 3 max, 7 min
      hotkey        packed 16-bit hotkey value
      runAsAdmin    boolean elevation hint
      relativePath  boolean, embed a ".\name" relative hint
      isDirectory   boolean, marks the target as a folder
      withIdList    boolean, also emit a link-target id list
  */
  function buildLnk(spec) {
    if (!spec || !spec.target || !String(spec.target).trim()) {
      throw new Error("a target path is required.");
    }
    var target = String(spec.target).trim();

    var flags = F_HAS_LINK_INFO | F_IS_UNICODE;
    var fileAttrs = spec.isDirectory ? FA_DIRECTORY : FA_ARCHIVE;

    var description = (spec.description || "").trim();
    var args = (spec.arguments || "").trim();
    var workingDir = (spec.workingDir || "").trim();
    if (!workingDir) workingDir = directoryOf(target);
    var iconPath = (spec.iconPath || "").trim();
    var relative = spec.relativePath ? ".\\" + baseNameOf(target) : "";

    /* id list is best-effort; only drive-rooted targets get one */
    var idList = null;
    if (spec.withIdList) {
      idList = buildIdList(target, !!spec.isDirectory);
      if (idList) flags |= F_HAS_LINK_TARGET_IDLIST;
    }

    if (description) flags |= F_HAS_NAME;
    if (relative)    flags |= F_HAS_RELATIVE_PATH;
    if (workingDir)  flags |= F_HAS_WORKING_DIR;
    if (args)        flags |= F_HAS_ARGUMENTS;
    if (iconPath)    flags |= F_HAS_ICON_LOCATION;
    if (spec.runAsAdmin) flags |= F_RUN_AS_USER;

    var header = writeHeader({
      iconIndex: iconPath ? (spec.iconIndex | 0) : 0,
      showCommand: (spec.showCommand | 0) || 1,
      hotkey: spec.hotkey | 0
    }, flags, fileAttrs);

    var chunks = [header];

    if (idList) {
      var idHead = new ByteBuf();
      idHead.u16(idList.length & 0xffff);   /* id list size, excludes this field */
      chunks.push(idHead.bytes());
      chunks.push(idList);
    }

    chunks.push(writeLinkInfo(target));

    /* string data order is fixed by the format */
    if (description) chunks.push(writeUnicodeString(description));
    if (relative)    chunks.push(writeUnicodeString(relative));
    if (workingDir)  chunks.push(writeUnicodeString(workingDir));
    if (args)        chunks.push(writeUnicodeString(args));
    if (iconPath)    chunks.push(writeUnicodeString(iconPath));

    /* extra data terminal block: a size field below 0x04 ends the section */
    var terminal = new ByteBuf();
    terminal.u32(0x00000000);
    chunks.push(terminal.bytes());

    return concat(chunks);
  }

  /* pack a hotkey: low byte is the virtual key, high byte is the modifier */
  function packHotkey(vk, modifier) {
    if (!vk) return 0;
    return ((modifier & 0xff) << 8) | (vk & 0xff);
  }

  /* ------------------------------------------------------------------ */
  /* decoder                                                             */
  /* ------------------------------------------------------------------ */

  /* a tiny little-endian reader over a uint8array */
  function Reader(bytes) { this.d = bytes; this.p = 0; }
  Reader.prototype.left = function () { return this.d.length - this.p; };
  Reader.prototype.u8 = function () { return this.d[this.p++]; };
  Reader.prototype.u16 = function () {
    var v = this.d[this.p] | (this.d[this.p + 1] << 8);
    this.p += 2; return v >>> 0;
  };
  Reader.prototype.u32 = function () {
    var v = (this.d[this.p]) | (this.d[this.p + 1] << 8) |
            (this.d[this.p + 2] << 16) | (this.d[this.p + 3] << 24);
    this.p += 4; return v >>> 0;
  };
  Reader.prototype.skip = function (n) { this.p += n; };
  Reader.prototype.ansiCounted = function (n) {
    var s = "";
    for (var i = 0; i < n; i++) s += String.fromCharCode(this.d[this.p++]);
    return s;
  };
  Reader.prototype.utf16Counted = function (chars) {
    var s = "";
    for (var i = 0; i < chars; i++) { s += String.fromCharCode(this.u16()); }
    return s;
  };
  Reader.prototype.ansiZ = function () {
    var s = "";
    while (this.p < this.d.length) {
      var c = this.d[this.p++];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  };

  function decodeFlags(flags) {
    var names = [];
    if (flags & F_HAS_LINK_TARGET_IDLIST) names.push("id list");
    if (flags & F_HAS_LINK_INFO)          names.push("link info");
    if (flags & F_HAS_NAME)               names.push("name");
    if (flags & F_HAS_RELATIVE_PATH)      names.push("relative path");
    if (flags & F_HAS_WORKING_DIR)        names.push("working dir");
    if (flags & F_HAS_ARGUMENTS)          names.push("arguments");
    if (flags & F_HAS_ICON_LOCATION)      names.push("icon location");
    if (flags & F_IS_UNICODE)             names.push("unicode");
    if (flags & F_RUN_AS_USER)            names.push("run as admin");
    return names;
  }

  function decodeShowCommand(v) {
    if (v === 3) return "maximized";
    if (v === 7) return "minimized";
    return "normal";
  }

  /* walk the id list, returning a short list of item summaries */
  function decodeIdList(r) {
    var size = r.u16();
    var end = r.p + size;
    var items = [];
    while (r.p < end) {
      var cb = r.u16();
      if (cb === 0) break;               /* terminator */
      var start = r.p;                   /* points just past cb */
      var type = r.d[start];
      var label;
      if (type === IT_ROOT) {
        label = "root (my computer)";
      } else if (type === IT_VOLUME) {
        label = "drive " + readAnsiAt(r.d, start + 1);
      } else if (type === IT_DIR || type === IT_FILE) {
        label = (type === IT_DIR ? "folder " : "file ") + readAnsiAt(r.d, start + 12);
      } else {
        label = "item type 0x" + type.toString(16);
      }
      items.push(label);
      r.p = start + (cb - 2);            /* advance past this item's data */
    }
    r.p = end;
    return items;
  }

  function readAnsiAt(d, off) {
    var s = "";
    while (off < d.length) {
      var c = d[off++];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  /* pull the ansi local base path out of a link-info block */
  function decodeLinkInfo(r) {
    var start = r.p;
    var size = r.u32();
    var headerSize = r.u32();
    var liFlags = r.u32();
    r.u32();                             /* volume id offset */
    var localBasePathOffset = r.u32();
    var basePath = "";
    if ((liFlags & LI_VOLUMEID_AND_LOCAL_BASE_PATH) && localBasePathOffset) {
      basePath = readAnsiAt(r.d, start + localBasePathOffset);
    }
    r.p = start + size;                  /* jump to the end of the block */
    return { basePath: basePath, size: size, headerSize: headerSize };
  }

  function decodeLnk(bytes) {
    if (!bytes || bytes.length < 0x4c) throw new Error("too small to be a .lnk.");
    var r = new Reader(bytes);
    var headerSize = r.u32();
    if (headerSize !== 0x4c) throw new Error("bad header size (not 0x4c).");
    /* clsid check */
    var okClsid = bytes[4] === 0x01 && bytes[5] === 0x14 && bytes[6] === 0x02;
    if (!okClsid) throw new Error("missing shell-link class id.");
    r.skip(16);                          /* past the clsid */

    var flags = r.u32();
    var fileAttrs = r.u32();
    r.skip(24);                          /* three filetimes */
    r.skip(4);                           /* file size */
    var iconIndex = r.u32() | 0;
    var showCommand = r.u32();
    var hotkey = r.u16();
    r.skip(2 + 4 + 4);                   /* reserved fields */

    var out = {
      flags: flags,
      flagNames: decodeFlags(flags),
      fileAttributes: fileAttrs,
      isDirectory: !!(fileAttrs & FA_DIRECTORY),
      iconIndex: iconIndex,
      showCommand: decodeShowCommand(showCommand),
      hotkey: hotkey,
      idList: [],
      basePath: "",
      name: "",
      relativePath: "",
      workingDir: "",
      arguments: "",
      iconLocation: ""
    };

    if (flags & F_HAS_LINK_TARGET_IDLIST) out.idList = decodeIdList(r);
    if (flags & F_HAS_LINK_INFO) {
      var li = decodeLinkInfo(r);
      out.basePath = li.basePath;
    }

    var unicode = !!(flags & F_IS_UNICODE);
    function readStr() {
      var count = r.u16();
      return unicode ? r.utf16Counted(count) : r.ansiCounted(count);
    }
    if (flags & F_HAS_NAME)          out.name = readStr();
    if (flags & F_HAS_RELATIVE_PATH) out.relativePath = readStr();
    if (flags & F_HAS_WORKING_DIR)   out.workingDir = readStr();
    if (flags & F_HAS_ARGUMENTS)     out.arguments = readStr();
    if (flags & F_HAS_ICON_LOCATION) out.iconLocation = readStr();

    return out;
  }

  root.Lnk = {
    build: buildLnk,
    decode: decodeLnk,
    packHotkey: packHotkey,
    baseNameOf: baseNameOf,
    directoryOf: directoryOf
  };
})(this);

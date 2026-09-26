/*
  app.js
  wires the plain form to the encoder in lnk.js, renders a hex preview,
  and hands the finished bytes to a download. no network calls.
*/

(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function setStatus(msg, ok) {
    var s = $("status");
    s.textContent = msg;
    s.className = ok ? "ok" : "bad";
  }

  /* fill the hotkey letter/number list a-z then 0-9, all lowercase labels */
  function fillHotkeys() {
    var sel = $("hkkey");
    var i, opt, code;
    for (i = 0; i < 26; i++) {
      code = 0x41 + i;                 /* virtual key for a-z */
      opt = document.createElement("option");
      opt.value = String(code);
      opt.textContent = String.fromCharCode(0x61 + i);
      sel.appendChild(opt);
    }
    for (i = 0; i < 10; i++) {
      code = 0x30 + i;                 /* virtual key for 0-9 */
      opt = document.createElement("option");
      opt.value = String(code);
      opt.textContent = String(i);
      sel.appendChild(opt);
    }
  }

  /* classic offset + hex + ascii dump, lowercase hex */
  function toHexDump(bytes) {
    var lines = [];
    var i, j;
    for (i = 0; i < bytes.length; i += 16) {
      var off = ("00000000" + i.toString(16)).slice(-8);
      var hex = "";
      var asc = "";
      for (j = 0; j < 16; j++) {
        if (i + j < bytes.length) {
          var v = bytes[i + j];
          hex += ("0" + v.toString(16)).slice(-2) + " ";
          asc += (v >= 0x20 && v < 0x7f) ? String.fromCharCode(v) : ".";
        } else {
          hex += "   ";
          asc += " ";
        }
        if (j === 7) hex += " ";
      }
      lines.push(off + "  " + hex + " " + asc);
    }
    return lines.join("\n");
  }

  function currentSpec() {
    var mod = parseInt($("hkmod").value, 10) || 0;
    var key = parseInt($("hkkey").value, 10) || 0;

    return {
      target: $("target").value,
      arguments: $("args").value,
      workingDir: $("workdir").value,
      description: $("desc").value,
      iconPath: $("iconpath").value,
      iconIndex: parseInt($("iconindex").value, 10) || 0,
      showCommand: parseInt($("showcmd").value, 10) || 1,
      hotkey: window.Lnk.packHotkey(key, mod),
      runAsAdmin: $("admin").checked,
      relativePath: $("relpath").checked,
      withIdList: $("idlist").checked
    };
  }

  function suggestedFilename() {
    var name = ($("name").value || "").trim();
    if (!name) {
      var t = $("target").value.trim();
      name = t ? window.Lnk.baseNameOf(t).replace(/\.[^.]*$/, "") : "shortcut";
    }
    name = name.replace(/[\\\/:*?"<>|]/g, "_");    /* strip illegal chars */
    if (!/\.lnk$/i.test(name)) name += ".lnk";
    return name;
  }

  function build() {
    try {
      var bytes = window.Lnk.build(currentSpec());
      return bytes;
    } catch (e) {
      setStatus(e.message || String(e), false);
      return null;
    }
  }

  function onPreview() {
    var bytes = build();
    if (!bytes) return;
    $("hex").textContent = toHexDump(bytes);
    setStatus(bytes.length + " bytes ready.", true);
  }

  function onMake() {
    var bytes = build();
    if (!bytes) return;
    $("hex").textContent = toHexDump(bytes);

    var blob = new Blob([bytes], { type: "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = suggestedFilename();
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);

    setStatus("built " + a.download + " (" + bytes.length + " bytes).", true);
  }

  /* picking a file just seeds the name field from its base name */
  function onPick() {
    var f = $("pick").files[0];
    if (!f) return;
    if (!$("name").value.trim()) {
      $("name").value = f.name.replace(/\.[^.]*$/, "");
    }
    if (!$("target").value.trim()) {
      $("target").value = f.name;   /* a hint only; user completes the path */
    }
    setStatus("name seeded from picked file. enter the full target path.", true);
  }

  /* render a decoded .lnk as a plain, aligned field list */
  function renderReport(info) {
    var lines = [];
    function row(k, v) {
      lines.push(("               " + k).slice(-15) + " : " + v);
    }
    row("flags", "0x" + ("0000000" + info.flags.toString(16)).slice(-8) +
        "  (" + info.flagNames.join(", ") + ")");
    row("attributes", "0x" + info.fileAttributes.toString(16) +
        (info.isDirectory ? "  (directory)" : ""));
    row("window", info.showCommand);
    row("icon index", String(info.iconIndex));
    row("hotkey", info.hotkey ? "0x" + info.hotkey.toString(16) : "(none)");
    if (info.idList.length) {
      row("id list", info.idList.length + " items");
      for (var i = 0; i < info.idList.length; i++) {
        lines.push("                 - " + info.idList[i]);
      }
    }
    if (info.basePath)     row("base path", info.basePath);
    if (info.name)         row("name", info.name);
    if (info.relativePath) row("relative", info.relativePath);
    if (info.workingDir)   row("working dir", info.workingDir);
    if (info.arguments)    row("arguments", info.arguments);
    if (info.iconLocation) row("icon path", info.iconLocation);
    return lines.join("\n");
  }

  function onDecode() {
    var f = $("decpick").files[0];
    if (!f) {
      setStatus("pick a .lnk file to decode first.", false);
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var bytes = new Uint8Array(reader.result);
        var info = window.Lnk.decode(bytes);
        $("report").textContent = renderReport(info);
        setStatus("decoded " + f.name + " (" + bytes.length + " bytes).", true);
      } catch (e) {
        $("report").textContent = "could not decode: " + (e.message || String(e));
        setStatus("decode failed.", false);
      }
    };
    reader.onerror = function () { setStatus("could not read the file.", false); };
    reader.readAsArrayBuffer(f);
  }

  function init() {
    fillHotkeys();
    $("make").addEventListener("click", onMake);
    $("preview").addEventListener("click", onPreview);
    $("pick").addEventListener("change", onPick);
    $("decode").addEventListener("click", onDecode);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

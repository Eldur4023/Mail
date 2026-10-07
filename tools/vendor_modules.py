#!/usr/bin/env python3
"""Copies the mail native modules from the sibling Lux repo (upstream) into vendor/lux, adapting them to the
vendored runtime's older module API (no signature strings, no hex_encode in crypto.hpp, no
mime.hpp / percent_encoding.hpp).  Run from anywhere:  python3 tools/vendor_modules.py
The CMake wiring in vendor/lux/CMakeLists.txt is done once by hand (see imap/mail/mailparse there)."""
import re, shutil
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
UP, V = PROJECT.parent / "Lux", PROJECT / "vendor" / "lux"   # upstream Lux is a sibling folder
MOD = "src/lux_script/modules/base_modules/"

for h in ("mime.hpp", "percent_encoding.hpp"):
    shutil.copy(UP / "include/lux" / h, V / "include/lux" / h)
for f in ("keyring.cpp", "mailparse.cpp", "imap.cpp", "mail.cpp"):
    shutil.copy(UP / MOD / f, V / MOD / f)

def edit(name, fn):
    p = V / MOD / name
    p.write_text(fn(p.read_text()))

def module_table(s, cls, name, rows):
    """Replaces `LUX_MODULE(name, {...})` / the signature-string table by a BuiltinModule class."""
    body = "".join(f'            {{"{n}", {lo}, {hi}, {fn}{", true" if a else ""}}},\n' for n, lo, hi, fn, a in rows)
    return cls, f'''class {cls} : public BuiltinModule {{
public:
    const char* name() const override {{ return "{name}"; }}
    const std::vector<BuiltinModuleFn>& functions() const override {{
        static const std::vector<BuiltinModuleFn> fns = {{
{body}        }};
        return fns;
    }}
}};

LUX_REGISTER_MODULE({cls})'''

# keyring / mailparse: only the registration changes
def keyring(s):
    s = re.sub(r'LUX_MODULE\(keyring, \{.*?\n\}\)', module_table(s, "KeyringModule", "keyring", [
        ("set", 3, 3, "fn_set", 1), ("get", 2, 2, "fn_get", 1), ("delete", 2, 2, "fn_delete", 1)])[1], s, flags=re.S)
    return s
def mailparse(s):
    return re.sub(r'class MailParseModule : public BuiltinModule \{.*?\n\};', lambda m: m.group(0)
        .replace('{"parse", "s>d", fn_parse}', '{"parse", 1, 1, fn_parse}')
        .replace('{"attachment", "si>s", fn_attachment}', '{"attachment", 2, 2, fn_attachment}'), s, flags=re.S)

def imap(s):
    s = s.replace('''// Folder + connection common to most functions.
#define IMAP_PREP(fn)                                                          \\
    Conn c;                                                                    \\
    if (!parse_conn(a[0], fn, c, error)) return Value::null();                 \\
    Session s(c);''', '''// The vendored module API has no signature strings: check argument types by hand.
// d Dict, s string, i int, l List (lowercase letters only, one per argument).
bool check_args(const std::vector<Value>& a, const char* spec, const char* fn, std::string& error) {
    for (size_t i = 0; spec[i]; ++i) {
        const Value& v = a[i];
        const bool ok = spec[i] == 'd' ? v.is_dict() : spec[i] == 's' ? v.is_str()
                      : spec[i] == 'i' ? v.is_int() : v.is_list();
        if (!ok) { error = std::string(fn) + "(): argument " + std::to_string(i + 1) + " has the wrong type"; return false; }
    }
    return true;
}

// Folder + connection common to most functions.
#define IMAP_PREP(fn, spec)                                                    \\
    if (!check_args(a, spec, fn, error)) return Value::null();                 \\
    Conn c;                                                                    \\
    if (!parse_conn(a[0], fn, c, error)) return Value::null();                 \\
    Session s(c);''')
    for fn, spec in [("list_folders", "d"), ("status", "ds"), ("uids", "dsi"), ("set_flags", "dsisl"),
                     ("move", "dsis"), ("append", "dss"), ("find", "dss"), ("remove", "dsi"),
                     ("create_folder", "ds"), ("rename_folder", "dss"), ("delete_folder", "ds")]:
        s = s.replace(f'IMAP_PREP("imap.{fn}")', f'IMAP_PREP("imap.{fn}", "{spec}")')
    s = s.replace('IMAP_PREP("imap.fetch")', 'IMAP_PREP("imap.fetch", "dsi")\n    if (a.size() > 3 && !a[3].is_str()) { error = "imap.fetch(): the section must be a string"; return Value::null(); }')
    i = s.index("LUX_MODULE(imap")
    cls, text = module_table(s, "ImapModule", "imap", [
        ("list_folders", 1, 1, "fn_list_folders", 1), ("status", 2, 2, "fn_status", 1), ("uids", 3, 3, "fn_uids", 1),
        ("fetch", 3, 4, "fn_fetch", 1), ("set_flags", 5, 5, "fn_set_flags", 1), ("move", 4, 4, "fn_move", 1),
        ("append", 3, 3, "fn_append", 1), ("find", 3, 3, "fn_find", 1), ("remove", 3, 3, "fn_remove", 1),
        ("create_folder", 2, 2, "fn_create_folder", 1), ("rename_folder", 3, 3, "fn_rename_folder", 1), ("delete_folder", 2, 2, "fn_delete_folder", 1)])
    return s[:i] + text + "\n\n} // namespace lux_script\n"   # the upstream "} // namespace" before LUX_MODULE stays

def mail(s):
    s = s.replace("crypto::hex_encode(", "hex(")
    s = s.replace("namespace {\n\nstruct Config", '''namespace {

// The vendored crypto.hpp predates hex_encode.
std::string hex(const std::string& raw) {
    static const char d[] = "0123456789abcdef";
    std::string out;
    for (unsigned char c : raw) { out += d[c >> 4]; out += d[c & 15]; }
    return out;
}

struct Config''', 1)
    s = s.replace('{"send", "d>b", fn_send, /*is_async=*/true},\n            {"compose", "d>s", fn_compose},\n            {"check", "d>b", fn_check, /*is_async=*/true},',
                  '{"send", 1, 1, fn_send, /*is_async=*/true},\n            {"compose", 1, 1, fn_compose},\n            {"check", 1, 1, fn_check, true},')
    for f in ("fn_compose", "fn_send", "fn_check"):
        s = s.replace(f"Value {f}(NativeCtx&, std::vector<Value>& a, std::string& error) {{\n",
                      f'Value {f}(NativeCtx&, std::vector<Value>& a, std::string& error) {{\n    if (!a[0].is_dict()) {{ error = "mail: the argument must be a Dict"; return Value::null(); }}\n')
    return s

edit("keyring.cpp", keyring); edit("mailparse.cpp", mailparse); edit("imap.cpp", imap); edit("mail.cpp", mail)
print("vendored: keyring mailparse imap mail")

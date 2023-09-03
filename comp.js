"use strict";

// todo: track line/char number, improve error messaging/stack trace
// todo: better JS api (e.g. importing/exporting objects/methods)
// todo: Infinity & NaN
// todo: in worker threads, import should only add to import object
// todo: indirect function type (not partial)
// todo: use SIMD for faster string/array comparison?
// todo: check for temporary instances in functions that need to be freed
// todo: ensure all array operations check bounds
// todo: check if safe_add_i32 should be used more
// todo: check if should be using more atomic ops
// todo: make field_setters thread safe?
// todo: gensym/namespace syntax quoted symbol
// todo: replace (i32$const ...func_idx_leb128) with (i32$const ...sleb128i64(func_idx)) [i32$const expects signed]
// todo: review all values created here (e.g. cached_string()) and consolidate/free
// todo: using varuint/varsint in all the right places?
// todo: should String have an array or just a memory block?
// todo: handle String/File encodings other than UTF8
// todo: emit number literal directly
// todo: replace impl_free with direct inner call to free_mem
// todo: atom keeps track of past values so it can free them
// todo: store comp default function in Method so it can be partialed/store local scope
// todo: free Function & VariadicFunction
// todo: make callable as a library (export init)
// todo: select features to include in compiled file (reading files, interpreting code, etc)
// todo: review emit_code section to make sure everything is being freed properly
// todo: allow setting initial & max memory pages
// todo: remove unneeded exports after compiling
// todo: store module_code before parsing, interpret macros & reader macros, & expand forms before storing
// todo: use eval to compile a form (e.g. in impl) and remove second compile from compile_form
// todo: emit code when parsing, store to compile later

(function init (module_code, module_len, module_off, parsed_len, mem_len) {
  const is_browser = this === this.window;
  if (is_browser) {
  
  } else {
    const argv = {
            compile: null,
            interpret: null,
            parse: null,
            init_pages: 1,
            max_pages: 65536
          },
          workers = require('node:worker_threads');
    let last_key;
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg.startsWith("--")) {
        last_key = arg.replace("--", "");
        if (argv[last_key] === null) argv[last_key] = [];
      } else {
        if (argv[last_key] instanceof Array) {
          argv[last_key].push(arg);
        } else if (argv[last_key] instanceof Number) {
          argv[last_key] = parseInt(arg);
        }
      }
    }
    function new_worker (pkg) {
      return new workers.Worker(pkg, { eval: true });
    }
    if (workers.isMainThread) {
      build_comp(new_worker, init, {
        is_browser: false,
        is_main: true
      }, argv, global, module_code, module_len, module_off, parsed_len, mem_len);
    } else {
      workers.parentPort.on("message", function (env) {
        build_comp(new_worker, init, env, argv, global, module_code);
      });
    }
  }
}).call(this);

function build_comp (
  new_worker,
  init,
  main_env,
  argv,
  js_imports,
  module_code,
  module_len,
  module_off,
  parsed_len,
  mem_len
) {

const fs = require("fs"),
      {minify} = require("uglify-js");

console.time("all");

/*------*\
|        |
| leb128 |
|        |
\*------*/

function uleb128i32 (num) {
  num |= 0;
  const arr = new Uint8Array(5);
  let count = 0;
  do {
    const byte_ = num & 0x7f;
    num >>= 7;
    arr[count++] = byte_ | (num ? 0x80 : 0);
  } while (num)
  return arr.subarray(0, count);
}

function uleb128i64 (num) {
  num = BigInt(num);
  const out = [];
  while (true) {
    const byte_ = Number(num & 0x7fn);
    num >>= 7n;
    if (!num) {
      out.push(byte_);
      return out;
    }
    out.push(byte_ | 0x80);
  }
}

function sleb128i64 (num) {
  num = BigInt(num);
  const out = [];
  while (true) {
    const byte_ = Number(num & 0x7fn);
    num >>= 7n;
    if (
      (num === 0n && (byte_ & 0x40) === 0) ||
      (num === -1n && (byte_ & 0x40) !== 0)
    ) {
      out.push(byte_);
      return out;
    }
    out.push(byte_ | 0x80);
  }
}

function sleb128i32 (num) {
  num |= 0;
  const arr = new Uint8Array(5);
  let count = 0, done = false;
  do {
    const byte_ = num & 0x7f;
    num >>= 7;
    done = (num === 0 && (byte_ & 0x40) === 0) ||
           (num === -1 && (byte_ & 0x40) !== 0)
    arr[count++] = byte_ | (done ? 0 : 0x80);
  } while (!done);
  return arr.subarray(0, count);
}

/*--------*\
|          |
| op codes |
|          |
\*--------*/

const wasm = {
  "unreachable":		0x00,
  "nop":			0x01,
  "block":			0x02,
  "loop":			0x03,
  "if":				0x04,
  "else":			0x05,
  "try":			0x06,
  "catch":			0x07,
  "throw":			0x08,
  "rethrow":			0x09,
  "end":			0x0b,
  "br":				0x0c,
  "br_if":			0x0d,
  "br_table":			0x0e,
  "return":			0x0f,
  "call":			0x10,
  "call_indirect":		0x11,
  "drop":			0x1a,
  "select":			0x1b,
  "select_t":			0x1c,
  "delegate":			0x18,
  "catch_all":			0x19,
  "local$get":			0x20,
  "local$set":			0x21,
  "local$tee":			0x22,
  "global$get":			0x23,
  "global$set":			0x24,
  "table$get":			0x25,
  "table$set":			0x26,
  "i32$load":			0x28,
  "i64$load":			0x29,
  "f32$load":			0x2a,
  "f64$load":			0x2b,
  "i32$load8_s":		0x2c,
  "i32$load8_u":		0x2d,
  "i32$load16_s":		0x2e,
  "i32$load16_u":		0x2f,
  "i64$load8_s": 		0x30,
  "i64$load8_u": 		0x31,
  "i64$load16_s":		0x32,
  "i64$load16_u":		0x33,
  "i64$load32_s":		0x34,
  "i64$load32_u":		0x35,
  "i32$store":			0x36,
  "i64$store":			0x37,
  "f32$store":			0x38,
  "f64$store":			0x39,
  "i32$store8":			0x3a,
  "i32$store16":		0x3b,
  "i64$store8":			0x3c,
  "i64$store16":		0x3d,
  "i64$store32":		0x3e,
  "memory$size":		0x3f,
  "memory$grow":		0x40,
  "i32$const":			0x41,
  "i64$const":			0x42,
  "f32$const":			0x43,
  "f64$const":			0x44,
  "i32$eqz":			0x45,
  "i32$eq":			0x46,
  "i32$ne":			0x47,
  "i32$lt_s":			0x48,
  "i32$lt_u":			0x49,
  "i32$gt_s":			0x4a,
  "i32$gt_u":			0x4b,
  "i32$le_s":			0x4c,
  "i32$le_u":			0x4d,
  "i32$ge_s":			0x4e,
  "i32$ge_u":			0x4f,
  "i64$eqz":			0x50,
  "i64$eq":			0x51,
  "i64$ne":			0x52,
  "i64$lt_s":			0x53,
  "i64$lt_u":			0x54,
  "i64$gt_s":			0x55,
  "i64$gt_u":			0x56,
  "i64$le_s":			0x57,
  "i64$le_u":			0x58,
  "i64$ge_s":			0x59,
  "i64$ge_u":			0x5a,
  "f32$eq":			0x5b,
  "f32$ne":			0x5c,
  "f32$lt":			0x5d,
  "f32$gt":			0x5e,
  "f32$le":			0x5f,
  "f32$ge":			0x60,
  "f64$eq":			0x61,
  "f64$ne":			0x62,
  "f64$lt":			0x63,
  "f64$gt":			0x64,
  "f64$le":			0x65,
  "f64$ge":			0x66,
  "i32$clz":			0x67,
  "i32$ctz":			0x68,
  "i32$popcnt":			0x69,
  "i32$add":			0x6a,
  "i32$sub":			0x6b,
  "i32$mul":			0x6c,
  "i32$div_s":			0x6d,
  "i32$div_u":			0x6e,
  "i32$rem_s":			0x6f,
  "i32$rem_u":			0x70,
  "i32$and":			0x71,
  "i32$or":			0x72,
  "i32$xor":			0x73,
  "i32$shl":			0x74,
  "i32$shr_s":			0x75,
  "i32$shr_u":			0x76,
  "i32$rotl":			0x77,
  "i32$rotr":			0x78,
  "i64$clz":			0x79,
  "i64$ctz":			0x7a,
  "i64$popcnt":			0x7b,
  "i64$add":			0x7c,
  "i64$sub":			0x7d,
  "i64$mul":			0x7e,
  "i64$div_s":			0x7f,
  "i64$div_u":			0x80,
  "i64$rem_s":			0x81,
  "i64$rem_u":			0x82,
  "i64$and":			0x83,
  "i64$or":			0x84,
  "i64$xor":			0x85,
  "i64$shl":			0x86,
  "i64$shr_s":			0x87,
  "i64$shr_u":			0x88,
  "i64$rotl":			0x89,
  "i64$rotr":			0x8a,
  "f32$abs":			0x8b,
  "f32$neg":			0x8c,
  "f32$ceil":			0x8d,
  "f32$floor":			0x8e,
  "f32$trunc":			0x8f,
  "f32$nearest":		0x90,
  "f32$sqrt":			0x91,
  "f32$add":			0x92,
  "f32$sub":			0x93,
  "f32$mul":			0x94,
  "f32$div":			0x95,
  "f32$min":			0x96,
  "f32$max":			0x97,
  "f32$copysign":		0x98,
  "f64$abs":			0x99,
  "f64$neg":			0x9a,
  "f64$ceil":			0x9b,
  "f64$floor":			0x9c,
  "f64$trunc":			0x9d,
  "f64$nearest":		0x9e,
  "f64$sqrt":			0x9f,
  "f64$add":			0xa0,
  "f64$sub":			0xa1,
  "f64$mul":			0xa2,
  "f64$div":			0xa3,
  "f64$min":			0xa4,
  "f64$max":			0xa5,
  "f64$copysign":		0xa6,
  "i32$wrap_i64":		0xa7,
  "i32$trunc_f32_s":		0xa8,
  "i32$trunc_f32_u":		0xa9,
  "i32$trunc_f64_s":		0xaa,
  "i32$trunc_f64_u":		0xab,
  "i64$extend_i32_s":		0xac,
  "i64$extend_i32_u":		0xad,
  "i64$trunc_f32_s":		0xae,
  "i64$trunc_f32_u":		0xaf,
  "i64$trunc_f64_s":		0xb0,
  "i64$trunc_f64_u":		0xb1,
  "f32$convert_i32_s":		0xb2,
  "f32$convert_i32_u":		0xb3,
  "f32$convert_i64_s":		0xb4,
  "f32$convert_i64_u":		0xb5,
  "f32$demote_f64":		0xb6,
  "f64$convert_i32_s":		0xb7,
  "f64$convert_i32_u":		0xb8,
  "f64$convert_i64_s":		0xb9,
  "f64$convert_i64_u":		0xba,
  "f64$promote_f32":		0xbb,
  "i32$reinterpret_f32":	0xbc,
  "i64$reinterpret_f64":	0xbd,
  "f32$reinterpret_i32":	0xbe,
  "f64$reinterpret_i64":	0xbf,
  "i32$extend8_s":		0xc0,
  "i32$extend16_s":		0xc1,
  "i64$extend8_s":		0xc2,
  "i64$extend16_s":		0xc3,
  "i64$extend32_s":		0xc4,
  "ref$null":			0xd0,
  "ref$is_null":		0xd1,
  "ref$func":			0xd2,
  "mem$prefix":			0xfc,
  "mem$copy":			0x0a,
  "mem$fill":			0x0b,
  "atomic$prefix":		0xfe,
  "memory$atomic$notify":	0x00,
  "memory$atomic$wait32":	0x01,
  "i32$atomic$load":		0x10,
  "i64$atomic$load":		0x11,
  "i32$atomic$load8_u":		0x12,
  "i64$atomic$load8_u":		0x14,
  "i32$atomic$store":		0x17,
  "i64$atomic$store":		0x18,
  "i32$atomic$store8":		0x19,
  "i64$atomic$store8":		0x1B,
  "i32$atomic$rmw$add":		0x1e,
  "i64$atomic$rmw$add":		0x1f,
  "i32$atomic$rmw$sub":		0x25,
  "i32$atomic$rmw$and":		0x2c,
  "i32$atomic$rmw$xchg":	0x41,
  "i32$atomic$rmw$cmpxchg":	0x48,
  void:				0x40,
  func:				0x60,
  funcref:			0x70,
  f64:				0x7c,
  f32:				0x7d,
  i64:				0x7e,
  i32:				0x7f
};

const encode = ((t) => t.encode.bind(t))(new TextEncoder),
      decode = ((t) => t.decode.bind(t))(new TextDecoder);

function wasm_encode_string (str) {
  const encoded = encode(str);
  return [encoded.length, ...encoded];
}

let module_section_enum = 0;

const type_section = module_section_enum++,
      memory_import_section = module_section_enum++,
      tag_import_section = module_section_enum++,
      func_import_section = module_section_enum++,
      func_section = module_section_enum++,
      table_section = module_section_enum++,
      tag_section = module_section_enum++,
      export_section = module_section_enum++,
      start_section = module_section_enum++,
      elem_section = module_section_enum++,
      code_section = module_section_enum++,
      data_section = module_section_enum++;

const module_sections = module_len ? [] : [
  [[wasm.func, 1, wasm.i32, 0]],
  [[
    ...wasm_encode_string("imports"),
    ...wasm_encode_string("memory"),
    2, 3, 1, ...uleb128i32(65536)
  ]],
  [
    [
      ...wasm_encode_string("imports"),
      ...wasm_encode_string("exception_tag"),
      4, 0, 0
    ]
  ],
  [],
  [],
  [[wasm.funcref, 0, 0]],
  [[0, 0]],
  [],
  [],
  [],
  [],
  []
];

const parsed_forms = new ArrayBuffer(0, { maxByteLength: 2 << 15 });

/*------*\
|        |
| base64 |
|        |
\*------*/

// based on https://github.com/niklasvh/base64-arraybuffer/blob/master/src/index.ts

const b64_alph = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const b64_lookup = new Uint8Array(256);

for (let i = 0; i < b64_alph.length; i++) {
  b64_lookup[b64_alph.charCodeAt(i)] = i;
}

function b64_encode (arr) {
  let arr32 = new Uint32Array(arr.buffer),
      len = arr32.length,
      i = 0,
      num = arr32[i],
      byt_cnt = 0,
      bytes = new Uint8Array(3),
      string = '';

  while (i < len) {
    while (byt_cnt < 3) {
      const byt = num & 0x7f;
      num >>>= 7;
      bytes[byt_cnt] = byt | (num ? 0x80 : 0);
      byt_cnt++;
      if (!num) {
        if (++i < len) num = arr32[i];
	else break;
      }
    }
 
    for (let j = 0; j < byt_cnt; j += 3) {
      const char1 = bytes[j],
            char2 = j + 1 < byt_cnt ? bytes[j + 1] : 0;
      string += b64_alph[char1 >> 2];
      string += b64_alph[((char1 & 3) << 4) | (char2 >> 4)];
      if (j + 1 === byt_cnt) {
        string += "==";
      } else {
        const char3 = j + 2 < byt_cnt ? bytes[j + 2] : 0;
        string += b64_alph[((char2 & 15) << 2) | (char3 >> 6)];
        if (j + 2 === byt_cnt) {
          string += "=";
        } else {
          string += b64_alph[char3 & 63];
        }
      }
    }

    byt_cnt = 0;
  }
  return string;
}

let had_start_section = false;

// todo: building Uint8Array directly is faster?
function build_module_section (curr, byt) {
  function reader (type, varints, bytes, next) {
    return {
      type,
      varints,
      mod_sec: curr.mod_sec,
      cnt: bytes || 0,
      content: [],
      prev: curr,
      next: typeof next === "function" ? next : () => next
    };
  }
  const first = !curr.type;
  if (first) curr = reader(byt, 2);
  const next = (function (curr) {
    let next;
    function final_next () {
      this.mod_sec.push(curr.content);
      curr.content = [];
      return --curr.cnt ? build_module_section(curr, byt) : curr.prev;
    }
    switch (curr.type) {
      // byte reader (array)
      case -1:
        curr.prev.content.push(byt);
        return --curr.cnt ? curr : curr.next();
      // varint reader (never appears here)
      case -2: return;
      // type section
      case 1:
        if (first) module_sections.push(curr.mod_sec = []);
        return reader(-1, 0, 1,
                 reader(-1, 1, 0,
                   reader(-1, 1, 0, final_next)));
      // import section
      case 2:
        if (first) {
          module_sections.push(
            curr.memory_imports = [],
            curr.tag_imports = [],
            curr.func_imports = []
          );
        }
        next = reader(-2, 1, 0, function () {
          let next;
          if (this.cnt === 0) {
            next = reader(-2, 1, 0, final_next);
            next.mod_sec = curr.func_imports;
          } else if (this.cnt === 2) {
            next = reader(-2, 3, 0, final_next);
            next.mod_sec = curr.memory_imports;
          } else if (this.cnt === 4) {
            next = reader(-2, 2, 0, final_next);
            next.mod_sec = curr.tag_imports;
          }
          return next;
        });
        return reader(-1, 1, 0, reader(-1, 1, 0, next));
      // function section
      case 3:
        curr.mod_sec = module_sections;
        return reader(-1, 0, 1, function () {
          this.cnt = curr.cnt - 1;
          curr.cnt = 1;
          this.next = final_next;
          return this;
        });
      // table section
      case 4:
      // tag section
      case 13:
        if (first) module_sections.push(curr.mod_sec = []);
      return reader(-2, curr.type === 4 ? 3 : 2, 0, final_next);
      // export section
      case 7:
        if (first) module_sections.push(curr.mod_sec = []);
        return reader(-1, 1, 0,
                 reader(-1, 0, 1, 
                   reader(-2, 1, 0, final_next)));
      // start_section
      case 8:
        // skip start_section; we only want it in pre-compiled code
        if (first) curr.mod_sec = [];
        had_start_section = true;
        curr.varints = 1;
        return reader(-2, 1, 0, function () {
          return curr.prev;
        });
      // elem section
      case 9:
        if (first) {
          // empty start_section
          module_sections.push([]);
          module_sections.push(curr.mod_sec = []);
        }
        return reader(-2, 2, 0,
                 reader(-1, 0, 1,
                   reader(-2, 1, 0,
                     reader(-1, 0, 3,
                       reader(-2, 1, 0, final_next)))));
      // code section
      case 10:
        if (first) module_sections.push(curr.mod_sec = []);
        return reader(-1, 1, 0, final_next);
      // data section
      case 11:
        if (first) curr.mod_sec = module_sections;
        curr.cnt = 1;
        next = reader(-1, 1, 0, function () {
          curr.content.splice(0, 3);
          return final_next.call(this);
        });
        return reader(-1, 0, 4, function () {
                 curr.content = [];
                 return next;
               });
    }
  })(curr);
  if (first) {
    curr.next = () => next;
    return curr;
  }
  return next;
}

function build_module_sections (bytes, idx, end, [curr, shift]) {
  let next;
  for (let i = idx; i < end; i++) {
    if (i >= 8) {
      if (!curr.type) {
        curr = build_module_section(curr, bytes[i]);
      } else if (curr.varints) {
        if (curr.type < 0) curr.prev.content.push(bytes[i]);
        curr.cnt |= (bytes[i] & 0x7f) << shift;
        if (bytes[i] & 0x80) {
          shift += 7;
        } else {
          curr.varints--;
          shift = 0;
          if (curr.type === -1) {
            if (!curr.cnt) curr = curr.next();
          } else if (!curr.varints) {
            curr = curr.next();
          } else {
            curr.cnt = 0;
          }
        }
      } else {
        curr = build_module_section(curr, bytes[i]);
      }
    }
  }
  return [curr, shift];
}

function b64_decode (string, module_len, offset, parsed_len) {
  parsed_forms.resize(parsed_len);

  let buff_len = Math.ceil((module_len + offset) / 4) * 4,
      len = string.length,
      idx = 0,
      char1,
      char2,
      char3,
      char4,
      bytes = new Uint8Array(3),
      num = 0,
      shift = 0,
      mod_sec_data = [{ type: 0, content: [] }, 0],
      parsed32_idx = 0;

  const buff = new ArrayBuffer(buff_len),
        arr32 = new Uint32Array(buff),
        arr8 = new Uint8Array(buff, offset, module_len),
        parsed32 = new Uint32Array(parsed_forms);

  for (let i = 0; i < len; i += 4) {
    char1 = b64_lookup[string.charCodeAt(i)];
    char2 = b64_lookup[string.charCodeAt(i + 1)];

    if (string[i + 2] === "=") {
      char3 = 0;
    } else {
      char3 = b64_lookup[string.charCodeAt(i + 2)];
    }

    if (string[i + 3] === "=") {
      char4 = 0;
    } else {
      char4 = b64_lookup[string.charCodeAt(i + 3)];
    }

    bytes[0] = (char1 << 2) | (char2 >> 4);
    bytes[1] = ((char2 & 15) << 4) | (char3 >> 2);
    bytes[2] = ((char3 & 3) << 6) | (char4 & 63);

    for (let j = 0; j < 3; j++) {
      num |= (bytes[j] & 0x7f) << shift;
      if (bytes[j] & 0x80) {
        shift += 7;
      } else {
        const start_byte = Math.max(idx * 4, offset) - offset;
        if (start_byte < module_len) {
          arr32[idx++] = num;
          const end_byte = idx * 4 - offset;
          mod_sec_data = build_module_sections(arr8, start_byte, end_byte, mod_sec_data);
        } else {
          parsed32[parsed32_idx++] = num;
        }
        num = 0;
        shift = 0;
        // if (idx === buff_len) break;
      }
    }
  }

  return arr8;
};

let precompiled = null;

if (module_len)
  precompiled = b64_decode(module_code, module_len, module_off, parsed_len);

/*--------------*\
|                |
| wasm interface |
|                |
\*--------------*/

// in a child thread memory will be provided through main_env
const memory = main_env.memory ||
  new WebAssembly.Memory({
    initial: (mem_len ? Math.ceil(mem_len / 65536) : 0) || argv.init_pages,
    maximum: argv.max_pages,
    shared: true
  });

const // exception type and data
      exception_tag = new WebAssembly.Tag({ parameters: ["i32"] }),
      imports = { memory: memory, exception_tag };

function _get_type_idx (spec) {
  const spec_sig = [
    wasm.func,
    ...uleb128i32(spec.params.length),
    ...spec.params,
    ...uleb128i32(spec.result.length),
    ...spec.result
  ];
  for (let i = 0; i < module_sections[type_section].length; i++) {
    const sig = module_sections[type_section][i];
    if (sig.length !== spec_sig.length) continue;
    let j;
    for (j = 0; j < sig.length; j++) {
      if (sig[j] !== spec_sig[j]) break;
    }
    if (j === sig.length) return i;
  }
  const type_idx = module_sections[type_section].length;
  module_sections[type_section].push(spec_sig);
  return type_idx;
}

// increment import_num instead of counting func_import_section because
// in compiled files, func_import_section will already be filled out
// this allows us to reinstantiate imported funcs in js w/o altering func_import_section
let import_num = 0,
    func_num = module_sections[func_section].length +
               module_sections[func_import_section].length;

function reserve_func_num (spec) {
  if (import_num < module_sections[func_import_section].length) {
    spec.func_idx = import_num;
  } else {
    spec.func_idx = func_num;
    func_num++;
  }
  spec.func_idx_leb128 = uleb128i32(spec.func_idx);
  return spec;
}

function func_wrapper (spec, cb) {
  spec.type_idx = _get_type_idx(spec);
  if (!spec.func_idx_leb128) reserve_func_num(spec);
  cb();
  return spec;
}

function func (spec) {
  return func_wrapper(spec, function () {
    const func_num = spec.func_idx - import_num;
    module_sections[func_section][func_num] = spec.type_idx;
    if (spec.export) {
      module_sections[export_section].push([
        ...wasm_encode_string(spec.export), 0,
        ...spec.func_idx_leb128
      ]);
    }
    const locals = [0];
    let curr_type;
    for (const t of spec.locals) {
      if (t === curr_type) {
        locals[locals.length - 2]++;
      } else {
        locals.push(1, t);
        locals[0]++;
        curr_type = t;
      }
    }
    spec.code.unshift(...locals);
    spec.code.push(wasm.end);
    module_sections[code_section][func_num] = [...uleb128i32(spec.code.length), ...spec.code];
  });
}

function import_func (
  i32_params = 0,
  i64_params = 0,
  f64_params = 0,
  results, func
) {
  const spec = { params: [] };
  for (let i = 0; i < i32_params; i++) spec.params.push(wasm.i32);
  for (let i = 0; i < i64_params; i++) spec.params.push(wasm.i64);
  for (let i = 0; i < f64_params; i++) spec.params.push(wasm.f64);
  spec.result = results;
  func_wrapper(spec, function () {
    const import_name = `func_import_${import_num++}`;
    imports[import_name] = func;
    // in compiled file, func_import_section will be provided,
    // so length will be greater than import_num
    // in that case we don't want to add to func_import_section
    // because it's already filled out
    if (module_sections[func_import_section].length < import_num) {
      module_sections[func_import_section].push([
        ...wasm_encode_string("imports"),
        ...wasm_encode_string(import_name),
        0, ...uleb128i32(spec.type_idx)
      ]);
    }
  });
  return Object.assign(func, spec);
}

const get_type_idx = import_func(
  4, 0, 0, [wasm.i32],
  function (
    i32_params,
    i64_params,
    f64_params,
    result_type
  ) {
    const params = [];
    for (let i = 0; i < i32_params; i++) params.push(wasm.i32);
    for (let i = 0; i < i64_params; i++) params.push(wasm.i64);
    for (let i = 0; i < f64_params; i++) params.push(wasm.f64);
    const result = result_type ? [result_type] : [];
    return _get_type_idx({ params, result });
  }
);

// !!! package cut

function func_builder (params, results, cb, xpt) {
  let local_num = 0;
  const spec = {
          params: [],
          locals: [],
          code: [],
          result: []
        },
        local_adder = function (coll) {
          return function (t) {
            coll.push(t);
            return uleb128i32(local_num++);
          };
        };
// todo: get rid of this when no longer needed:
  if (typeof params === "function") {
    cb = params;
  } else if (params) {
    const old_cb = cb;
    cb = function (func) {
      const param_idx = [];
      for (let i = 0; i < params.length; i++) {
        param_idx.push(func.param(params[i]));
      }
      if (xpt) func.set_export(xpt);
      func.add_result(...results);
      func.append_code(...old_cb.call(func, ...param_idx));
    };
  }
  reserve_func_num(spec);
  // allows defining function and building later
  spec.build = function (cb) {
    cb({
      param: local_adder(spec.params),
      local: local_adder(spec.locals),
      func_idx_leb128: spec.func_idx_leb128,
      append_code: (...ops) => spec.code.push(...ops),
      add_result: (...types) => {
        for (const t of types) if (t) spec.result.push(t);
      },
      set_export: (xp) => spec.export = xp
    });
    return func(spec);
  }
  if (cb) return spec.build(cb);
  return spec;
}

const funcs = {
  built: {},
  uleb128: {},
  sleb128: {},
  comp: [],
  build: function (
    nm,
    params,
    results,
    opts,
    builder_func
  ) {
    const xpt = opts.export ? nm : null;
    const func = func_builder(params, results, builder_func, xpt);
    if (nm) {
      store_func_for_comp(nm, params, results[0], func.func_idx, opts);
      this.built[nm] = func;
// todo: still need to do func_idx_leb128?
      this.uleb128[nm] = uleb128i32(func.func_idx);
      this.sleb128[nm] = sleb128i32(func.func_idx);
    }
    return func;
  }
};

function store_func_for_comp (
  nm, params, result, func_idx, opts
) {
  if (opts.comp) {
    const params_i32 = params.filter(x => x === wasm.i32).length;
    const params_i64 = params.filter(x => x === wasm.i64).length;
    const params_f64 = params.filter(x => x === wasm.f64).length;
    if (opts.comp !== true) {
      func_idx = funcs.build(null, params, [result], {}, function (...params) {
        let code = [];
        for (let i = 0; i < params.length; i++) {
          code.push(wasm.local$get, ...uleb128i32(i));
        }
        code.push(wasm.call, ...uleb128i32(func_idx));
        for (let i = 0; i < opts.comp.length; i++) {
          code = opts.comp[i](this, code);
        }
        return code;
      }).func_idx;
    }
    funcs.comp.push([nm, params_i32, params_i64, params_f64, result, func_idx]);
  }
}

// !!! package cut

/*---------*\
|           |
| ref table |
|           |
\*---------*/

// todo: why can't we return 0 as an index?
const ref_table = [null];

let next_ref_address = 0;

const store_ref = import_func(
  1, 0, 0, [wasm.i32],
  function (obj) {
    let nra = next_ref_address;
    if (nra) {
      next_ref_address = ref_table[nra];
    } else {
      nra = ref_table.length;
    }
    ref_table[nra] = obj;
    return nra;
  }
);

function load_ref (idx) {
  return ref_table[idx];
}

const free_ref = import_func(
  1, 0, 0, [],
  function (idx) {
    ref_table[idx] = next_ref_address;
    next_ref_address = idx;
  }
);

/*----------*\
|            |
| open funcs |
|            |
\*----------*/

// todo: why can't we return 0 as an index?
const open_funcs = [null];

let next_func_idx = 0;

const start_func = import_func(
  0, 0, 0, [wasm.i32],
  function () {
    const curr_func = reserve_func_num({
      params: [],
      result: [],
      locals: [],
      code: []
    });
    let idx = next_func_idx;
    if (idx) {
      next_func_idx = open_funcs[idx];
    } else {
      idx = open_funcs.length;
    }
    open_funcs[idx] = curr_func;
    return idx;
  }
);

const get_func_num = import_func(
  1, 0, 0, [wasm.i32],
  function (idx) {
    return open_funcs[idx].func_idx;
  }
);

const end_func = import_func(
  1, 0, 0, [wasm.i32],
  function (idx) {
    const out = func(open_funcs[idx]);
    open_funcs[idx] = next_func_idx;
    next_func_idx = idx;
    return out.func_idx;
  }
);

const set_export = import_func(
  2, 0, 0, [wasm.i32],
  function (fidx, xpt) {
    open_funcs[fidx].export = load_ref(xpt);
    free_ref(xpt);
    return fidx;
  }
);

function push_code (coll) {
  return import_func(
    2, 0, 0, [wasm.i32],
    function (fidx, code) {
      if (code) open_funcs[fidx][coll].push(code);
      return fidx;
    }
  );
}

const add_param = push_code("params"),
      add_local = push_code("locals"),
      add_result = push_code("result"),
      append_code = push_code("code");

const prepend_code = import_func(
  2, 0, 0, [wasm.i32],
  function (fidx, code) {
    open_funcs[fidx].code.unshift(code);
    return fidx;
  }
);

function add_varint32 (append, signed) {
  return import_func(
    2, 0, 0, [wasm.i32],
    function (fidx, num) {
      num = signed ? sleb128i32(num) : uleb128i32(num);
      const code = open_funcs[fidx].code;
      code[append ? "push" : "unshift"](...num);
      return fidx;
    }
  );
}

const append_varsint64 = import_func(
  1, 1, 0, [wasm.i32],
  function (fidx, num) {
    const code = open_funcs[fidx].code;
    code.push(...sleb128i64(num));
    return fidx;
  }
);

const prepend_varuint32 = add_varint32(false, false),
      append_varuint32 = add_varint32(true, false),
      prepend_varsint32 = add_varint32(false, true),
      append_varsint32 = add_varint32(true, true);

const get_op_code = import_func(
  2, 0, 0, [wasm.i32],
  function (namespace, name) {
    const ns_str = load_ref(namespace);
    let op_name = load_ref(name);
    if (ns_str) op_name = ns_str + "$" + op_name;
    free_ref(namespace);
    free_ref(name);
    return wasm[op_name];
  }
);

/*----------*\
|            |
| start func |
|            |
\*----------*/

const start_funcs = [];

let start_func_index = -1

function complete_start_section () {
  if (start_func_index !== -1) {
    let sfi = end_func(start_func_index);
    start_funcs.push(sfi);
    module_sections[start_section] = uleb128i32(sfi);
    start_func_index = -1;
  } else {
    module_sections[start_section] = [];
  }
}

const add_to_start_func = import_func(
  1, 0, 0, [],
  function (fidx) {
    start_funcs.push(fidx);
    fidx = uleb128i32(fidx);
    if (start_func_index === -1) start_func_index = start_func();
    open_funcs[start_func_index].code.push(wasm.call);
    open_funcs[start_func_index].code.push(...fidx);
    return fidx;
  }
);

/*-------*\
|         |
| compile |
|         |
\*-------*/

let comp;

function flatten_table_section () {
  const out = [];
  for (const [type, flags, size] of module_sections[table_section]) {
    out.push(type, flags, ...uleb128i32(size));
  }
  return out;
}

// todo: can use Uint8Array directly? Faster?
function build_module_code (data) {
  complete_start_section();
  const import_section = [
          ...module_sections[memory_import_section],
          ...module_sections[tag_import_section],
          ...module_sections[func_import_section]
        ],
        ts = [
          ...uleb128i32(module_sections[type_section].length),
          ...module_sections[type_section].flat()
        ],
        is = [
          ...uleb128i32(import_section.length),
          ...import_section.flat()
        ],
        fs = [
          ...uleb128i32(module_sections[func_section].length),
          ...module_sections[func_section]
        ],
        bs = [
          ...uleb128i32(module_sections[table_section].length),
          ...flatten_table_section()
        ],
        as = [
          ...uleb128i32(module_sections[tag_section].length),
          ...module_sections[tag_section].flat()
        ],
        es = [
          ...uleb128i32(module_sections[export_section].length),
          ...module_sections[export_section].flat()
        ],
        ssl = module_sections[start_section].length,
        ss = ssl ? [
          8, ...uleb128i32(ssl), ...module_sections[start_section]
        ] : [],
        ls = [
          ...uleb128i32(module_sections[elem_section].length),
          ...module_sections[elem_section].flat()
        ],
        cs = [
          ...uleb128i32(module_sections[code_section].length),
          ...module_sections[code_section].flat()
        ],
        ds = data ? [
          1, 0, wasm.i32$const, 0, wasm.end,
          ...uleb128i32(module_sections[data_section].length),
          ...module_sections[data_section]
        ] : [],
        module_code = [
          0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
          1,  ...uleb128i32(ts.length), ...ts,
          2,  ...uleb128i32(is.length), ...is,
          3,  ...uleb128i32(fs.length), ...fs,
          4,  ...uleb128i32(bs.length), ...bs,
          13, ...uleb128i32(as.length), ...as,
          7,  ...uleb128i32(es.length), ...es,
          ...ss,
          9,  ...uleb128i32(ls.length), ...ls,
          10, ...uleb128i32(cs.length), ...cs,
          ...(data ? [11, ...uleb128i32(ds.length), ...ds] : [])
        ];
  return Uint8Array.from(module_code);
}

const compile = import_func(
  0, 0, 0, [],
  function (code) {
    const module_code = code || build_module_code(false),
          mod = new WebAssembly.Module(module_code),
          inst = new WebAssembly.Instance(mod, { imports });
// todo: this does not transfer to parsed file
    while (start_funcs.length) {
      module_sections[code_section][
        start_funcs.pop() - import_num
      ] = [2, 0, 0xb];
    }
    comp = inst.exports;
  }
);

/*------*\
|        |
| method |
|        |
\*------*/

const new_func_table = import_func(
  0, 0, 0, [wasm.i32],
  function () {
    const table_idx = module_sections[table_section].length;
    module_sections[table_section].push([wasm.funcref, 0, 0]);
    return table_idx;
  }
);

const impl_method = import_func(
  3, 0, 0, [],
  function (mtd_num, type_num, func_num) {
    const mtd_table = module_sections[table_section][mtd_num];
    if (mtd_table[2] <= type_num) mtd_table[2] = type_num + 1;
// todo: track already implemented and overwrite instead of
// pushing new implementation
    module_sections[elem_section].push([
      2, ...uleb128i32(mtd_num),
      wasm.i32$const, ...sleb128i32(type_num), wasm.end, 
      0, 1, ...uleb128i32(func_num)
    ]);
  }
);

// export comp func for use with call_indirect
const add_to_func_table = import_func(
  1, 0, 0, [wasm.i32],
  function (func_num) {
    const idx = module_sections[table_section][0][2];
    impl_method(0, idx, func_num);
    return idx;
  }
);

/*----------*\
|            |
| js interop |
|            |
\*----------*/

const js_eq = import_func(
  2, 0, 0, [wasm.i32],
  function (a, b) {
    return (load_ref(a) === load_ref(b)) ? 1 : 0;
  }
);

const js_add = import_func(
  2, 0, 0, [wasm.i32],
  function (a, b) {
    return store_ref(load_ref(a) + load_ref(b));
  }
);

const js_get = import_func(
  2, 0, 0, [wasm.i32],
  function (obj, prop) {
    obj = load_ref(obj);
    prop = load_ref(prop);
    const out = obj[prop];
    return comp.Object(store_ref(out));
  }
);

const js_call = import_func(
  3, 0, 0, [wasm.i32],
  function (obj, mtd, arr) {
    obj = comp_string_to_js(obj);
    mtd = comp_string_to_js(mtd);
    const args = [],
          len = comp.Array$length(arr);
    for (let i = 0; i < len; i++) {
      const obj = comp.to_js(comp.array_get_i32(arr, i));
      args.push(load_ref(comp.Object$address(obj)));
    }
    const out = js_imports[obj][mtd](...args);
    return comp.Object(store_ref(out));
  }
);

/*-------*\
|         |
| package |
|         |
\*-------*/

function slice_source (str) {
  const cut_point = `\n// !!! package cut\n`;
  let start_cut = str.indexOf(cut_point);
  while (start_cut > -1) {
    const cut = str.slice(start_cut + cut_point.length),
          aft_cut = cut.slice(cut.indexOf(cut_point) + cut_point.length + 1);
    str = str.slice(0, start_cut);
    str += aft_cut;
    start_cut = str.indexOf(cut_point);
  }
  return str;
}

let next_addr;

// todo: how to build package file from within one?
function build_package () {
  let func_code = slice_source(build_comp.toString());
  func_code += `(${init.toString()}).call(this,`;
  const last_addr = new DataView(memory.buffer).getUint32(next_addr, true);
  module_sections[data_section] = new Uint8Array(memory.buffer, 0, last_addr);
  let module_b64, off;
  const module_code = build_module_code(true),
        module_len = module_code.length,
        parsed_len = parsed_forms.byteLength,
        full_len = module_len + parsed_len;
  for (let i = 0; i < 4; i++) {
    // length needs to be multiple of 4 to use Uint32Array in b64_encode:
    const bytes = new Uint8Array(Math.ceil((full_len + i) / 4) * 4);
    // todo: can we make this faster?
    bytes.set(module_code, i);
    bytes.set(new Uint8Array(parsed_forms), module_len + i);
    const temp_b64 = b64_encode(bytes);
    if (!module_b64 || (temp_b64.length < module_b64.length)) {
      module_b64 = temp_b64;
      off = i;
    }
  }
  func_code += `"${module_b64}",${module_len},${off},${parsed_len},${last_addr});`;
  if (typeof minify !== "undefined") func_code = minify(func_code).code;
  return func_code;
}

/*--------------*\
|                |
| string interop |
|                |
\*--------------*/

function comp_string_to_js (addr) {
  const len = comp.String$length(addr),
        arr = comp.String$arr(addr),
        bytes = new DataView(memory.buffer, comp.Array$arr(arr), len);
  return decode(bytes);
}

const store_string = import_func(
  1, 0, 0, [wasm.i32],
  function (str) {
    return store_ref(comp_string_to_js(str));
  }
);

function js_string_to_comp (str) {
  const bytes = encode(str),
        len = bytes.byteLength,
        arrlen = Math.ceil(len / 4),
        arr = comp.array_by_length(arrlen);
  new Uint8Array(memory.buffer).set(bytes, comp.Array$arr(arr));
  return comp.String(arr, len);
}

let cached_strings = {};

function cached_string (str) {
  if (!cached_strings[str])
    cached_strings[str] = js_string_to_comp(str);
  return cached_strings[str];
}

/*------------*\
|              |
| File interop |
|              |
\*------------*/

const file_close = import_func(
  1, 0, 0, [],
  function (fstr) {
    fs.closeSync(comp.File$fd(fstr));
  }
);

const file_length = import_func(
  1, 0, 0, [wasm.i32],
  function (fstr) {
    const fd = comp.File$fd(fstr);
    return fs.fstatSync(fd).size;
  }
);

const file_get_string_chunk = import_func(
  3, 0, 0, [wasm.i32],
  function (fstr, start, len) {
    const arr = comp.array_by_length(Math.ceil(len / 4)),
// todo: update global DataView when memory grows
          buf = new DataView(memory.buffer),
          fd = comp.File$fd(fstr),
          br = fs.readSync(fd, buf, comp.Array$arr(arr), len, start);
    return comp.String(arr, br);
  }
);

/*-------*\
|         |
| threads |
|         |
\*-------*/

let thread_port;

// todo: maintain thread pool
const start_thread = import_func(
  0, 0, 0, [wasm.i32],
  function () {
    if (!main_env.is_browser) {
      const thread_port = comp.alloc(8),
            sub_env = {
              memory: memory,
              is_browser: main_env.is_browser,
              thread_port: thread_port,
              is_main: false
            },
            pkg = get_cuts(build_package(), "thread"),
            worker = new_worker(pkg);
      // (new DataView(memory.buffer)).setUint32(thread_port + 4, 1, true);
      worker.postMessage(sub_env);
      // return thread_port;
    }
  }
);

const nil = 0,
      max_inst_size = 256;

// addresses 4 through max_inst_size are for freed memory blocks
let curr_addr = max_inst_size;

const comp_false = curr_addr += 4,
      comp_true = curr_addr += 4;

// !!! package cut

/*----*\
|      |
| COMP |
|      |
\*----*/

const memview = new DataView(memory.buffer);
memview.setUint32(comp_false, 1, true);
memview.setUint32(comp_true, 2, true);
// storage location of the next available addr for alloc
next_addr = curr_addr += 4;
const avail_mem = curr_addr += 4;
memview.setUint32(next_addr, curr_addr += 4, true);
memview.setUint32(avail_mem, 65536, true);

funcs.build("i32_div_ceil",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (dividend, divisor) {
    return [
      wasm.local$get, ...dividend,
      wasm.if, wasm.i32,
        wasm.local$get, ...dividend,
        wasm.i32$const, 1,
        wasm.i32$sub,
        wasm.local$get, ...divisor,
        wasm.i32$div_u,
        wasm.i32$const, 1,
        wasm.i32$add,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  }
);

funcs.build("get_next_address",
  [wasm.i32], [wasm.i32], {},
  function (size) {
    const out = this.local(wasm.i32),
          next_page = this.local(wasm.i32),
          new_addr = this.local(wasm.i32),
          grow_pages = this.local(wasm.i32);
    return [
      wasm.loop, wasm.void,
        wasm.i32$const, ...sleb128i32(next_addr),
        wasm.atomic$prefix,
        wasm.i32$atomic$load, 2, 0,
        wasm.local$tee, ...out,
        wasm.local$get, ...size,
        wasm.i32$add,
        wasm.local$tee, ...new_addr,
        wasm.local$get, ...out,
        wasm.i32$gt_u,
        wasm.if, wasm.i32,
          wasm.i32$const, ...sleb128i32(next_addr),
          wasm.local$get, ...out,
          wasm.local$get, ...new_addr,
          wasm.atomic$prefix,
          wasm.i32$atomic$rmw$cmpxchg, 2, 0,
          wasm.local$get, ...out,
          wasm.i32$ne,
          wasm.if, wasm.i32,
            wasm.br, 2,
          wasm.else,
            wasm.loop, wasm.i32,
              wasm.local$get, ...new_addr,
              wasm.i32$const, ...sleb128i32(avail_mem),
              wasm.atomic$prefix,
              wasm.i32$atomic$load, 2, 0,
              wasm.local$tee, ...next_page,
              // next_page is the starting byte of the next page,
              // so if this is equal, then we have exactly enough
              // bytes in the current page
              wasm.i32$gt_u,
              wasm.if, wasm.i32,
                wasm.i32$const, ...sleb128i32(avail_mem),
                wasm.local$get, ...next_page,
                wasm.local$get, ...next_page,
                wasm.local$get, ...new_addr,
                wasm.local$get, ...next_page,
                wasm.i32$sub,
                wasm.i32$const, ...sleb128i32(65536),
                wasm.call, ...funcs.uleb128.i32_div_ceil,
                wasm.local$tee, ...grow_pages,
                wasm.i32$const, ...sleb128i32(65536),
                wasm.i32$mul,
                wasm.i32$add,
                wasm.atomic$prefix,
                wasm.i32$atomic$rmw$cmpxchg, 2, 0,
                // if not equal to next_page, then another thread already grew memory
                wasm.local$get, ...next_page,
                wasm.i32$eq,
                wasm.if, wasm.i32,
                  wasm.local$get, ...grow_pages,
                  wasm.memory$grow, 0,
                  // failure returns -1
                  wasm.i32$const, ...sleb128i32(-1),
                  wasm.i32$eq,
                wasm.else,
                  // another thread grew memory, but possibly not enough, so try again
                  wasm.br, 2,
                wasm.end,
              wasm.else,
                wasm.i32$const, 0,
              wasm.end,
            wasm.end,
          wasm.end,
        wasm.else,
          wasm.i32$const, 1,
        wasm.end,
        wasm.if, wasm.void,
          wasm.i32$const, 0,
          wasm.i32$const, 0,
          wasm.throw, 0,
        wasm.end,
      wasm.end,
      wasm.local$get, ...out
    ];
  }
);

funcs.build("alloc",
  [wasm.i32], [wasm.i32], { export: true },
  function (type_size) {
    // size in bytes
    const addr = this.local(wasm.i32);
    return [
      // load previously freed address for type and set as addr
      // type_size is also address where freed blocks are stored
      wasm.local$get, ...type_size,
      wasm.i32$const, 0,
      wasm.atomic$prefix,
      // replace address with zero so other threads will use get_next_address
      wasm.i32$atomic$rmw$xchg, 2, 0,
      wasm.local$tee, ...addr,
      // above returns value in type_addr
      wasm.if, wasm.i32,
        // store previous next type address as next type address
        // previous next type address was stored where some freed data was previously stored
        // this will result in a chain until we get back to 0
        wasm.local$get, ...type_size,
        wasm.local$get, ...addr,
        wasm.i32$load, 2, 0,
        wasm.atomic$prefix,
        wasm.i32$atomic$store, 2, 0,
        wasm.local$get, ...addr,
        wasm.i32$const, 0,
        wasm.local$get, ...type_size,
        wasm.mem$prefix,
        wasm.mem$fill, 0,
        wasm.local$get, ...addr,
      wasm.else,
        // if == 0, then we need to calculate the next maximum address
        wasm.local$get, ...type_size,
        wasm.call, ...funcs.uleb128.get_next_address,
      wasm.end
    ];
  }
);

funcs.build("free_mem",
  [wasm.i32, wasm.i32], [], {},
  function (addr, size) {
    return [
      wasm.local$get, ...addr,
      // size is the address where last freed address is stored
      wasm.local$get, ...size,
      wasm.local$get, ...addr,
      wasm.atomic$prefix,
      // put the address there -- this returns previous stored address
      wasm.i32$atomic$rmw$xchg, 2, 0,
      wasm.atomic$prefix,
      // store previous address in addr
      wasm.i32$atomic$store, 2, 0
    ];
  }
);

funcs.build("get_ops_for_field_type",
  [wasm.i32], [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32], {},
  function (field_type) {
    const field_size = this.local(wasm.i32),
          mem_size = this.local(wasm.i32),
          load_op = this.local(wasm.i32),
          store_op = this.local(wasm.i32),
          const_op = this.local(wasm.i32);
    return [
      wasm.local$get, ...field_type,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$eq,
      wasm.if, wasm.void,
        wasm.i32$const, 4,
        wasm.local$set, ...field_size,
        wasm.i32$const, 2,
        wasm.local$set, ...mem_size,
        wasm.i32$const, ...sleb128i32(wasm.i32$load),
        wasm.local$set, ...load_op,
        wasm.i32$const, ...sleb128i32(wasm.i32$store),
        wasm.local$set, ...store_op,
        wasm.i32$const, ...sleb128i32(wasm.i32$const),
        wasm.local$set, ...const_op,
      wasm.end,
      wasm.local$get, ...field_type,
      wasm.i32$const, ...sleb128i32(wasm.i64),
      wasm.i32$eq,
      wasm.if, wasm.void,
        wasm.i32$const, 8,
        wasm.local$set, ...field_size,
        wasm.i32$const, 3,
        wasm.local$set, ...mem_size,
        wasm.i32$const, ...sleb128i32(wasm.i64$load),
        wasm.local$set, ...load_op,
        wasm.i32$const, ...sleb128i32(wasm.i64$store),
        wasm.local$set, ...store_op,
        wasm.i32$const, ...sleb128i32(wasm.i64$const),
        wasm.local$set, ...const_op,
      wasm.end,
      wasm.local$get, ...field_type,
      wasm.i32$const, ...sleb128i32(wasm.f64),
      wasm.i32$eq,
      wasm.if, wasm.void,
        wasm.i32$const, 8,
        wasm.local$set, ...field_size,
        wasm.i32$const, 3,
        wasm.local$set, ...mem_size,
        wasm.i32$const, ...sleb128i32(wasm.f64$load),
        wasm.local$set, ...load_op,
        wasm.i32$const, ...sleb128i32(wasm.f64$store),
        wasm.local$set, ...store_op,
        wasm.i32$const, ...sleb128i32(wasm.f64$const),
        wasm.local$set, ...const_op,
      wasm.end,
      wasm.local$get, ...field_size,
      wasm.local$get, ...mem_size,
      wasm.local$get, ...load_op,
      wasm.local$get, ...store_op,
      wasm.local$get, ...const_op
    ];
  }
);

funcs.build("make_accessor_func",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (type_size, field_name, result_type, mem_size, load_op) {
    const _func = this.local(wasm.i32);
    return [
      wasm.call, ...start_func.func_idx_leb128,
      wasm.local$tee, ..._func,
      wasm.local$get, ...field_name,
      wasm.call, ...set_export.func_idx_leb128,
      // first param is value address
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_param.func_idx_leb128,
      // result type is field type
      wasm.local$get, ...result_type,
      wasm.call, ...add_result.func_idx_leb128,
      // get value address
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.func_idx_leb128,
      // add type-size (current offset)
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...type_size,
      wasm.call, ...append_varsint32.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.i32$add),
      wasm.call, ...append_code.func_idx_leb128,
      // load data
      wasm.local$get, ...load_op,
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...mem_size,
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.call, ...end_func.func_idx_leb128
    ];
  }
);

// todo: use offset instead of setter_func
funcs.build("add_field_to_type_constructor",
  [
    wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32,
    wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32
  ],
  [wasm.i32, wasm.i32], {},
  function (
    inner_func, outer_func, field_offset, field_num, param_num,
    field_type, use_default, _default, const_op, setter_func
  ) {
    return [
      wasm.local$get, ...inner_func,
      wasm.local$get, ...field_type,
      wasm.call, ...add_param.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...field_num,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$tee, ...field_num,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...setter_func,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.drop,
      wasm.local$get, ...use_default,
      // if default given, then add it to the code of the constructor_func
      wasm.if, wasm.i32,
        wasm.local$get, ...outer_func,
        wasm.local$get, ...const_op,
        wasm.call, ...append_code.func_idx_leb128,
        wasm.local$get, ..._default,
        wasm.call, ...append_varsint32.func_idx_leb128,
      // otherwise, add it as a parameter to the constructor_func
      wasm.else,
        wasm.local$get, ...outer_func,
        wasm.local$get, ...field_type,
        wasm.call, ...add_param.func_idx_leb128,
        wasm.i32$const, ...sleb128i32(wasm.local$get),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.local$get, ...param_num,
        wasm.call, ...append_varuint32.func_idx_leb128,
        // increment param_num for next call of add_field...
        wasm.local$get, ...param_num,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.local$set, ...param_num,
      wasm.end,
      wasm.drop,
      wasm.local$get, ...field_num,
      wasm.local$get, ...param_num
    ];
  }
);

funcs.build("create_setter_func",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (field_type, offset, mem_size, store_op) {
    return [
      wasm.call, ...start_func.func_idx_leb128,
      // first param is value address
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_param.func_idx_leb128,
      wasm.local$get, ...field_type,
      wasm.call, ...add_param.func_idx_leb128,
      // get value address
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...offset,
      wasm.call, ...append_varsint32.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.i32$add),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, 1,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.local$get, ...store_op,
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...mem_size,
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.call, ...end_func.func_idx_leb128
    ];
  }
);

funcs.build("add_type_field",
  [
    wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32,
    wasm.i32, wasm.i32, wasm.i32, wasm.i32
  ],
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  { export: true },
  function (
    inner_func, outer_func, type_size, field_num, param_num,
    field_name, field_type, use_default, _default
  ) {
    const field_size = this.local(wasm.i32),
          mem_size = this.local(wasm.i32),
          load_op = this.local(wasm.i32),
          store_op = this.local(wasm.i32),
          const_op = this.local(wasm.i32),
          getter_func = this.local(wasm.i32);
    return [
      wasm.local$get, ...field_type,
      wasm.call, ...funcs.uleb128.get_ops_for_field_type,
      wasm.local$set, ...const_op,
      wasm.local$set, ...store_op,
      wasm.local$set, ...load_op,
      wasm.local$set, ...mem_size,
      wasm.local$set, ...field_size,
  
      wasm.local$get, ...type_size,
      wasm.local$get, ...field_name,
      wasm.local$get, ...field_type,
      wasm.local$get, ...mem_size,
      wasm.local$get, ...load_op,
      wasm.call, ...funcs.uleb128.make_accessor_func,
      wasm.local$set, ...getter_func,
  
      wasm.local$get, ...inner_func,
      wasm.local$get, ...outer_func,
      wasm.local$get, ...type_size,
      wasm.local$get, ...field_num,
      wasm.local$get, ...param_num,
      wasm.local$get, ...field_type,
      wasm.local$get, ...use_default,
      wasm.local$get, ..._default,
      wasm.local$get, ...const_op,
  
      wasm.local$get, ...field_type,
      wasm.local$get, ...type_size,
      wasm.local$get, ...mem_size,
      wasm.local$get, ...store_op,
      wasm.call, ...funcs.uleb128.create_setter_func,
  
      wasm.call, ...funcs.uleb128.add_field_to_type_constructor,
      wasm.local$set, ...param_num,
      wasm.local$set, ...field_num,
  
      wasm.local$get, ...type_size,
      wasm.local$get, ...field_size,
      wasm.i32$add,
      wasm.local$get, ...field_num,
      wasm.local$get, ...param_num,
      wasm.local$get, ...getter_func
    ];
  }
);

funcs.build("start_type",
  [], [wasm.i32, wasm.i32], { export: true },
  function () {
    return [
      wasm.call, ...start_func.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_param.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_result.func_idx_leb128,
      wasm.call, ...start_func.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_result.func_idx_leb128
    ];
  }
);

funcs.build("end_type",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], { export: true },
  function (
    inner_func,
    outer_func,
    type_size,
    field_num,
    type_name
  ) {
    return [
      wasm.local$get, ...outer_func,
      wasm.local$get, ...type_name,
      wasm.call, ...set_export.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...inner_func,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.call, ...end_func.func_idx_leb128,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.i32$const, ...funcs.sleb128.alloc,
      wasm.call, ...prepend_varuint32.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...prepend_code.func_idx_leb128,
      wasm.local$get, ...type_size,
      wasm.call, ...prepend_varsint32.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...prepend_code.func_idx_leb128,
      wasm.call, ...end_func.func_idx_leb128,
      wasm.local$get, ...field_num,
      wasm.local$get, ...type_size
    ];
  }
);

compile();

/*------------*\
|              |
| define types |
|              |
\*------------*/

const types = {};

let next_type_num = 0;

function define_type (type_name, ...fields) {
  let [inner_func, outer_func] = comp.start_type(),
      type_size = 0,
      field_num = 0,
      param_num = 0;
  const type_num = next_type_num++,
        params = [],
        type_info = types[type_name] = {
          name: type_name,
          type_num: type_num,
          fields: {}
        };
  fields.unshift("_type_num", "i32", 1, type_num, 0);
  for (let i = 0; i < fields.length; i += 5) {
    const field_name = fields[i],
          field_type = fields[i + 1],
          use_default = fields[i + 2],
          deft = fields[i + 3],
          comp_type = fields[i + 4],
          field_offset = type_size;
    let acc_func;
    if (!use_default) params.push({
      wasm_type: wasm[field_type],
      comp_type: comp_type
    });
    [
      type_size,
      field_num,
      param_num,
      acc_func
    ] = comp.add_type_field(
      inner_func,
      outer_func,
      type_size,
      field_num,
      param_num,
      store_ref(type_name + "$" + field_name),
      wasm[field_type],
      use_default, deft
    );
    type_info.fields[field_name] = {
      func_idx: acc_func,
      leb128: uleb128i32(acc_func),
      wasm_type: wasm[field_type],
      offset: field_offset
    };
    if (comp_type) {
      const res = comp_type === wasm[field_type] ? comp_type : wasm.i32;
      store_func_for_comp(
        `${type_name}$${field_name}`, [wasm.i32], res, acc_func, {
	  comp: comp_type === wasm[field_type] || [wrap_result_i32_to_int]
        }
      );
    }
  }
  [
    outer_func,
    param_num,
    type_size
  ] = comp.end_type(
    inner_func,
    outer_func,
    type_size,
    param_num,
    store_ref(type_name)
  );
  type_info.constr = {
    func_idx: outer_func,
    leb128: uleb128i32(outer_func),
    params: params
  };
  store_func_for_comp(
    `${type_name}$new`, params, wasm.i32, outer_func, { comp: true }
  );
  type_info.size = type_size;
}

define_type("Nil");
define_type("False");
define_type("True");

define_type(
  "Int",
  "refs", "i32", 1, 0, 0,
  "value", "i64", 0, 0, wasm.i64
);

define_type(
  "Float",
  "refs", "i32", 1, 0, 0,
  "value", "f64", 0, 0, wasm.f64
);

// todo: replace with Int
define_type(
  "Boxedi32",
  "refs", "i32", 1, 0, 0,
  "value", "i32", 0, 0, 0
);

define_type(
  "Object",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "address", "i32", 0, 0, 0
);

define_type(
  "String",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "arr", "i32", 0, 0, wasm.i32,
  "length", "i32", 0, 0, wasm.i64
);

define_type(
  "File",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "fd", "i32", 0, 0, wasm.i64
);

define_type(
  "Exception",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "data", "i32", 0, 0, wasm.i32,
  "msg", "i32", 0, 0, wasm.i32
);

define_type(
  "Symbol",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "namespace", "i32", 0, 0, wasm.i32,
  "name", "i32", 0, 0, wasm.i32
);

define_type(
  "Keyword",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "namespace", "i32", 0, 0, wasm.i32,
  "name", "i32", 0, 0, wasm.i32,
);

define_type(
  "Function",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "func_num", "i32", 0, 0, 0,
  "tbl_idx", "i32", 0, 0, 0,
  "type_num", "i32", 0, 0, 0,
  "result",  "i32", 0, 0, wasm.i64,
  "i32_params", "i32", 0, 0, wasm.i64,
  "i64_params", "i32", 0, 0, wasm.i64,
  "f64_params", "i32", 0, 0, wasm.i64
);

define_type(
  "VariadicFunction",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "func", "i32", 0, 0, wasm.i32,
  "args", "i32", 0, 0, wasm.i32
);

define_type(
  "Method",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "num", "i32", 0, 0, 0,
  "default_func", "i32", 0, 0, 0,
  "main_func", "i32", 0, 0, wasm.i32
);

define_type(
  "Array",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
// todo: change to "memblk"
  "arr", "i32", 0, 0, 0,
// todo: change to "size"
  "length", "i32", 0, 0, wasm.i64,
  "original", "i32", 0, 0, 0
);

define_type(
  "RefsArray",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "arr", "i32", 0, 0, 0
);

// todo: keep track of past data to free
define_type(
  "Atom",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "data", "i32", 0, 0, 0,
  "mutex", "i32", 0, 0, 0
);

define_type(
  "TaggedData",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "tag", "i32", 0, 0, wasm.i32,
  "data", "i32", 0, 0, wasm.i32
);

define_type(
  "Metadata",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "meta", "i32", 0, 0, wasm.i32,
  "data", "i32", 0, 0, wasm.i32
);

define_type(
  "Type",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "num", "i32", 0, 0, 0
);

define_type(
  "PartialNode",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "arr", "i32", 0, 0, 0,
  "bitmap", "i32", 0, 0, 0
);

define_type(
  "FullNode",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "arr", "i32", 0, 0, 0
);

define_type(
  "HashCollisionNode",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "arr", "i32", 0, 0, 0,
  "collision_hash", "i32", 0, 0, 0
);

define_type(
  "LeafNode",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "key", "i32", 0, 0, wasm.i32,
  "val", "i32", 0, 0, wasm.i32
);

define_type(
  "HashMap",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "root", "i32", 0, 0, 0,
  "count", "i32", 0, 0, wasm.i64
);

define_type(
  "Vector",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "count", "i32", 0, 0, wasm.i64,
  "shift", "i32", 0, 0, 0,
  "root", "i32", 0, 0, 0,
  "tail", "i32", 0, 0, 0
);

define_type(
  "VectorSeq",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "arr", "i32", 0, 0, 0,
  "arr_off", "i32", 0, 0, 0,
  "vec", "i32", 0, 0, wasm.i32,
  "vec_off", "i32", 0, 0, 0
);

define_type(
  "HashMapNodeSeq",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "curr_seq", "i32", 0, 0, 0,
  "nodes", "i32", 0, 0, 0,
  "offset", "i32", 0, 0, 0
);

define_type(
  "HashMapSeq",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "map", "i32", 0, 0, wasm.i32,
  "root", "i32", 0, 0, 0
);

define_type(
  "LazySeq",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "generator", "i32", 0, 0, 0,
  "seq", "i32", 0, 0, 0,
  "seq_set", "i32", 0, 0, 0
);

define_type(
  "ConsSeq",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "first", "i32", 0, 0, 0,
  "rest", "i32", 0, 0, 0
);

define_type(
  "ConcatSeq",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "left", "i32", 0, 0, 0,
  "right", "i32", 0, 0, 0
);

define_type(
  "Seq",
  "refs", "i32", 1, 0, 0,
  "hash", "i32", 1, 0, 0,
  "root", "i32", 0, 0, 0
);

/*-----*\
|       |
| flags |
|       |
\*-----*/

function def_flag (type, name) {
  if (type.flags._mask === 4) throw "no flags available";
  type.flags[name] = type.flags._mask;
  type.flags._mask >>>= 1;
}

funcs.build("get_flag",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (val, mask) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...types.Symbol.fields.refs.leb128,
      wasm.local$get, ...mask,
      wasm.i32$and,
      wasm.i32$const, 0,
      wasm.i32$ne
    ];
  }
);

funcs.build("set_flag",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (val, mask, bit) {
    const addr = this.local(wasm.i32),
          prev = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.i32$const, ...sleb128i32(types.Symbol.fields.refs.offset),
      wasm.i32$add,
      wasm.local$tee, ...addr,
      wasm.local$get, ...addr,
      wasm.i32$load, 2, 0,
      wasm.local$tee, ...prev,
      wasm.local$get, ...prev,
      wasm.local$get, ...bit,
      wasm.i32$const, ...sleb128i32(-1),
      wasm.i32$mul,
      wasm.i32$xor,
      wasm.i32$const, 1,
      wasm.local$get, ...mask,
      wasm.i32$ctz,
      wasm.i32$shl,
      wasm.i32$and,
      wasm.i32$xor,
      wasm.i32$store, 2, 0,
      wasm.local$get, ...prev,
      wasm.local$get, ...mask,
      wasm.i32$and,
      wasm.i32$const, 0,
      wasm.i32$ne
    ];
  }
);

// /*-------*\
// |         |
// | partial |
// |         |
// \*-------*/
// 
// const def_partial = func_builder(function (func) {
//   const func_num = func.param(wasm.i32),
//         args = func.param(wasm.i32);
//   func.add_result(wasm.i32);
//   func.append_code(
//     wasm.local$get, ...func_num,
//     wasm.call, ...add_partial_to_table.func_idx_leb128,
//     wasm.local$get, ...args,
//     wasm.call, ...PartialFunc.constr_leb128
//   );
// });
// 
// const call_partial = func_builder(function (func) {
//   const partial = func.param(wasm.i32);
//   func.add_result(wasm.i32);
//   func.append_code(
//     wasm.local$get, ...partial,
//     wasm.call, ...PartialFunc.args_leb128,
//     wasm.local$get, ...partial,
//     wasm.call, ...PartialFunc.tbl_idx_leb128,
//     wasm.call_indirect,
//     ...leb128i32(get_type_idx(1, 0, 0, wasm.i32)), 0
//   );
// });

/*-------*\
|         |
| def_mtd |
|         |
\*-------*/

// add a param to the default func and main func of a polymethod
funcs.build("add_params_to_main_mtd_func",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32], {},
  function (main_func, start_param, num_params, param_type) {
    const curr_param = this.local(wasm.i32);
    return [
      // data type and number of params provided
      // loop here through the number of params
      wasm.loop, wasm.void,
        wasm.local$get, ...curr_param,
        wasm.local$get, ...num_params,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          // add the param to the main func
          wasm.local$get, ...main_func,
          wasm.local$get, ...param_type,
          wasm.call, ...add_param.func_idx_leb128,
          // add to the code of main func
          // (local.get n) where n is the param num we started on plus curr_param
          wasm.i32$const, ...sleb128i32(wasm.local$get),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.local$get, ...start_param,
          wasm.local$get, ...curr_param,
          wasm.i32$add,
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.drop,
          wasm.local$get, ...curr_param,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...curr_param,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...main_func,
      wasm.local$get, ...start_param,
      wasm.local$get, ...num_params,
      wasm.i32$add
    ];
  }
);

// finish the main func for a method, which is the function directly called
funcs.build("finish_mtd_main_func",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (
    main_func,
    type_idx,
    poly_table,
    i32_params,
    i64_params,
    f64_params
  ) {
    return [
      // get the first arg
      wasm.local$get, ...main_func,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.func_idx_leb128,
      // load the type num from the address
      wasm.i32$const, ...sleb128i32(wasm.i32$load),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, 2,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.func_idx_leb128,
      // call_indirect using the type num as the index to the poly table
      wasm.i32$const, ...sleb128i32(wasm.call_indirect),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...type_idx,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.local$get, ...poly_table,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.call, ...end_func.func_idx_leb128,
      wasm.local$tee, ...main_func,
      wasm.local$get, ...main_func,
      wasm.call, ...add_to_func_table.func_idx_leb128,
      wasm.local$get, ...type_idx,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.local$get, ...i32_params,
      wasm.local$get, ...i64_params,
      wasm.local$get, ...f64_params,
      wasm.call, ...types.Function.constr.leb128
    ];
  }
);

funcs.build("new_comp_method",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32], { export: true },
  function (
    mtd_name,
    i32_params,
    i64_params,
    f64_params,
    result_type
  ) {
    const mtd_table = this.local(wasm.i32),
          main_func = this.local(wasm.i32),
          type_idx = this.local(wasm.i32),
          num_params = this.local(wasm.i32);
    return [
      wasm.call, ...start_func.func_idx_leb128,
      wasm.local$tee, ...main_func,
      wasm.local$get, ...mtd_name,
      wasm.if, wasm.void,
        wasm.local$get, ...main_func,
        wasm.local$get, ...mtd_name,
        wasm.call, ...set_export.func_idx_leb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...result_type,
      wasm.call, ...add_result.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.local$get, ...i32_params,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...funcs.uleb128.add_params_to_main_mtd_func,
      wasm.local$get, ...i64_params,
      wasm.i32$const, ...sleb128i32(wasm.i64),
      wasm.call, ...funcs.uleb128.add_params_to_main_mtd_func,
      wasm.local$get, ...f64_params,
      wasm.i32$const, ...sleb128i32(wasm.f64),
      wasm.call, ...funcs.uleb128.add_params_to_main_mtd_func,
      wasm.drop,
      wasm.drop,
      wasm.call, ...new_func_table.func_idx_leb128,
      wasm.local$set, ...mtd_table,
      wasm.local$get, ...i32_params,
      wasm.local$get, ...i64_params,
      wasm.local$get, ...f64_params,
      wasm.local$get, ...result_type,
      wasm.call, ...get_type_idx.func_idx_leb128,
      wasm.local$set, ...type_idx,
      wasm.local$get, ...main_func,
      wasm.local$get, ...type_idx,
      wasm.local$get, ...mtd_table,
      wasm.local$get, ...i32_params,
      wasm.local$get, ...i64_params,
      wasm.local$get, ...f64_params,
      wasm.call, ...funcs.uleb128.finish_mtd_main_func,
      wasm.local$get, ...mtd_table
    ];
  }
);

compile();

const defined_methods = [];

function def_mtd (name, num_i32, num_i64, num_f64, res, opts, def_func) {
  const params = [];
  for (let i = 0; i < num_i32; i++) params.push(wasm.i32);
  for (let i = 0; i < num_i64; i++) params.push(wasm.i64);
  for (let i = 0; i < num_f64; i++) params.push(wasm.f64);
  const result = res ? [res] : [];
  if (def_func) {
    if (typeof def_func === "function") {
      def_func = funcs.build(
        `${name}$default`, params, result, {}, def_func
      );
    }
  } else if (!def_func) {
    def_func = { func_idx: 0, func_idx_leb128: [0] };
  }
  const [ mtd_func, mtd_num ] = comp.new_comp_method(
    name ? sleb128i32(store_ref(name)) : [0],
    num_i32, num_i64, num_f64, res,
  );
  const func_idx = comp.Function$func_num(mtd_func);
  store_func_for_comp(name, params, res, func_idx, opts);
  return {
    name: name,
    mtd_num: mtd_num,
    num_args: num_i32 + num_i64 + num_f64,
    def_func: def_func.func_idx,
    def_func_leb128: def_func.func_idx_leb128,
    func_idx: func_idx,
    func_idx_leb128: uleb128i32(func_idx),
    main_func: mtd_func,
    implemented: {},
    implement: function (type, func) {
      this.implemented[type.name] = true;
      impl_method(mtd_num, type.type_num, 
        func instanceof Function ?
        funcs.build(`${name}$${type.name}`, params, result, {}, func).func_idx :
        func
      );
    }
  };
}

// todo: only export when opts.export
function pre_new_method (name, num_i32, num_i64, num_f64, res, opts, def_func) {
  num_i64 ||= 0;
  num_f64 ||= 0;
  const out = def_mtd(name, num_i32, num_i64, num_f64, res, opts, def_func);
  defined_methods.push(out);
  for (let i = 0; i < next_type_num; i++) {
    impl_method(out.mtd_num, i, out.def_func);
  }
  return out;
}

/*----*\
|      |
| free |
|      |
\*----*/

const free = pre_new_method("free", 1, 0, 0, 0, {});

funcs.build("dec_refs",
  [wasm.i32], [wasm.i32], {},
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.i32$const, ...sleb128i32(types.Symbol.fields.refs.offset),
      wasm.i32$add,
      wasm.i32$const, 1,
      wasm.atomic$prefix,
      // atomically subtract 1 from refs, returns previous value:
      wasm.i32$atomic$rmw$sub, 2, 0
    ];
  }
);

function impl_free (type, own_free) {
  free.implement(type, function (val) {
    const refs = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.call, ...funcs.uleb128.dec_refs,
      wasm.i32$const, ...sleb128i32(0x3fffffff), // strip first two bits
      wasm.i32$and,
      // if refs was 0 before dec_refs, proceed with cleanup
      wasm.i32$eqz,
      wasm.if, wasm.void,
        // type-specific cleanup:
        wasm.local$get, ...val,
        wasm.call, ...func_builder(own_free).func_idx_leb128,
        // free value itself:
        wasm.if, wasm.void,
          wasm.local$get, ...val,
          wasm.i32$const, ...sleb128i32(type.size),
          wasm.call, ...funcs.uleb128.free_mem,
        wasm.end,
      wasm.end
    ];
  });
}

// value should never be freed:
const no_free = func => [];

free.implement(types.Nil, no_free);
free.implement(types.False, no_free);
free.implement(types.True, no_free);
free.implement(types.Symbol, no_free);
free.implement(types.Keyword, no_free);
// todo: free these, but make sure global vars are protected
free.implement(types.Method, no_free);
free.implement(types.Type, no_free);
free.implement(types.VariadicFunction, no_free);
free.implement(types.Function, no_free);

// no type-specific cleanup, just use default:
function simple_free (func) {
  func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(wasm.i32$const, 1);
}

impl_free(types.Boxedi32, simple_free);
impl_free(types.Int, simple_free);
impl_free(types.Float, simple_free);

const inc_refs = pre_new_method("inc_refs", 1, 0, 0, wasm.i32, {},
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.i32$const, ...sleb128i32(types.Symbol.fields.refs.offset),
      wasm.i32$add,
      wasm.i32$const, 1,
      wasm.atomic$prefix,
      wasm.i32$atomic$rmw$add, 2, 0,
      wasm.drop,
      wasm.local$get, ...val,
    ];
  }
);

function no_inc_refs (val) {
  return [wasm.local$get, ...val];
}

inc_refs.implement(types.Nil, no_inc_refs);
inc_refs.implement(types.False, no_inc_refs);
inc_refs.implement(types.True, no_inc_refs);
inc_refs.implement(types.Symbol, no_inc_refs);
inc_refs.implement(types.Keyword, no_inc_refs);
inc_refs.implement(types.Method, no_inc_refs);
inc_refs.implement(types.Type, no_inc_refs);

/*-----*\
|       |
| Array |
|       |
\*-----*/

// todo: check index against array length (in comp)
function array_getter (align, res_typ, load, exp) {
  if (!exp) exp = res_typ;
  return funcs.build(`array_get_${exp}`,
    [wasm.i32, wasm.i32], [wasm[res_typ]], { export: true },
    function (arr, idx) {
      return [
        wasm.local$get, ...arr,
        wasm.call, ...types.Array.fields.arr.leb128,
        wasm.local$get, ...idx,
        wasm.i32$const, align,
        wasm.i32$shl,
        wasm.i32$add,
        wasm[load], align, 0
      ];
    }
  );
}

const array_get_i8  = array_getter(0, "i32", "i32$load8_u", "i8");
const array_get_i32 = array_getter(2, "i32", "i32$load");
const array_get_i64 = array_getter(3, "i64", "i64$load");
const array_get_f64 = array_getter(3, "f64", "f64$load");

funcs.build("refs_array_get",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, idx) {
    return [
      wasm.local$get, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.local$get, ...idx,
      wasm.call, ...funcs.uleb128.array_get_i32
    ];
  }
);

// todo: check index against array length (in comp)
function array_setter (align, val_typ, nm, store) {
  return funcs.build(`array_set_${nm}`,
    [wasm.i32, wasm.i32, wasm[val_typ]],
    [wasm.i32], { export: true },
    function (arr, idx, val) {
      return [
        wasm.local$get, ...arr,
        wasm.call, ...types.Array.fields.arr.leb128,
        wasm.local$get, ...idx,
        wasm.i32$const, align,
        wasm.i32$shl,
        wasm.i32$add,
        wasm.local$get, ...val,
        wasm[store], align, 0,
        wasm.local$get, ...arr
      ];
    }
  );
}

const array_set_i8  = array_setter(0, "i32", "i8",  "i32$store8");
const array_set_i32 = array_setter(2, "i32", "i32", "i32$store");
const array_set_i64 = array_setter(3, "i64", "i64", "i64$store");
const array_set_f64 = array_setter(3, "f64", "f64", "f64$store");

funcs.build("refs_array_set_no_inc",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, idx, val) {
    return [
      // stage the return val before we overwrite the variable
      wasm.local$get, ...arr,
      wasm.local$get, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.local$tee, ...arr,
      wasm.local$get, ...idx,
      wasm.call, ...funcs.uleb128.array_get_i32,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$get, ...arr,
      wasm.local$get, ...idx,
      wasm.local$get, ...val,
      wasm.call, ...funcs.uleb128.array_set_i32,
      wasm.drop
    ];
  }
);

funcs.build("refs_array_set",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, idx, val) {
    return [
      // stage the return val before we overwrite the variable
      wasm.local$get, ...arr,
      wasm.local$get, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.local$tee, ...arr,
      wasm.local$get, ...idx,
      wasm.call, ...funcs.uleb128.array_get_i32,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$get, ...arr,
      wasm.local$get, ...idx,
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.call, ...funcs.uleb128.array_set_i32,
      wasm.drop
    ];
  }
);

// todo: test that len < arr.len (in comp)
funcs.build("subarray",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, start, len) {
    return [
      wasm.local$get, ...arr,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.call, ...types.Array.fields.arr.leb128,
      wasm.local$get, ...start,
      wasm.i32$add,
      wasm.local$get, ...len,
      wasm.local$get, ...arr,
      wasm.call, ...types.Array.constr.leb128
    ];
  }
);

impl_free(types.Array, function (func) {
  const arr = func.param(wasm.i32),
        org = func.local(wasm.i32),
        idx = func.local(wasm.i32),
        len = func.local(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    // if this is a subarray:
    wasm.local$get, ...arr,
    wasm.call, ...types.Array.fields.original.leb128,
    wasm.local$tee, ...org,
    wasm.if, wasm.void,
      wasm.local$get, ...org,
      wasm.call, ...free.func_idx_leb128,
    wasm.else,
      wasm.local$get, ...arr,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.i32$const, 2,
      wasm.i32$shl,
      wasm.local$set, ...len,
      wasm.local$get, 0,
      wasm.call, ...types.Array.fields.arr.leb128,
      wasm.local$set, ...arr,
      wasm.loop, wasm.void,
        // can only free in chunks of max_inst_size
        wasm.local$get, ...len,
        wasm.i32$const, ...sleb128i32(max_inst_size),
        wasm.i32$gt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...arr,
          wasm.i32$const, ...sleb128i32(max_inst_size),
          wasm.call, ...funcs.uleb128.free_mem,
          wasm.local$get, ...arr,
          wasm.i32$const, ...sleb128i32(max_inst_size),
          wasm.i32$add,
          wasm.local$set, ...arr,
          wasm.local$get, ...len,
          wasm.i32$const, ...sleb128i32(max_inst_size),
          wasm.i32$sub,
          wasm.local$set, ...len,
          wasm.br, 1,
        wasm.else,
          wasm.local$get, ...len,
          wasm.if, wasm.void,
            wasm.local$get, ...arr,
            wasm.local$get, ...len,
            wasm.call, ...funcs.uleb128.free_mem,
          wasm.end,
        wasm.end,
      wasm.end,
    wasm.end,
    wasm.i32$const, 1
  );
});

impl_free(types.RefsArray, function (func) {
  const arr = func.param(wasm.i32),
        idx = func.local(wasm.i32),
        cnt = func.local(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...arr,
    wasm.call, ...types.RefsArray.fields.arr.leb128,
    wasm.local$tee, ...arr,
    wasm.call, ...types.Array.fields.length.leb128,
    wasm.local$set, ...cnt,
    wasm.loop, wasm.void,
      wasm.local$get, ...idx,
      wasm.local$get, ...cnt,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.array_get_i32,
        wasm.call, ...free.func_idx_leb128,
        wasm.local$get, ...idx,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.local$set, ...idx,
        wasm.br, 1,
      wasm.end,
    wasm.end,
    wasm.local$get, ...arr,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

funcs.build("array_by_length",
  [wasm.i32], [wasm.i32], { export: true },
  function (len) {
    const size = this.local(wasm.i32);
    return [
      wasm.local$get, ...len,
      wasm.if, wasm.i32,
        wasm.local$get, ...len,
        // len is number of i32s, so multiply by 4 for number of bytes
        wasm.i32$const, 2,
        wasm.i32$shl,
        wasm.local$tee, ...size,
        wasm.i32$const, ...sleb128i32(max_inst_size),
        wasm.i32$gt_u,
        wasm.if, wasm.i32,
          // if > max_inst_size, reserve a new address space
          // this will be freed later in chunks of max_inst_size
          wasm.local$get, ...size,
          wasm.call, ...funcs.uleb128.get_next_address,
        wasm.else,
          // if <= max_inst_size, use alloc to get a free block as usual
          wasm.local$get, ...size,
          wasm.call, ...funcs.uleb128.alloc,
        wasm.end,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end,
      wasm.local$get, ...len,
      wasm.i32$const, 0,
      wasm.call, ...types.Array.constr.leb128
    ];
  }
);

funcs.build("refs_array_by_length",
  [wasm.i32], [wasm.i32], { export: true },
  function (len) {
    return [
      wasm.local$get, ...len,
      wasm.call, ...funcs.uleb128.array_by_length,
      wasm.call, ...types.RefsArray.constr.leb128
    ];
  }
);

funcs.build("array_copy",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (src, i, dst, j, len) {
    return [
      wasm.local$get, ...dst,
      wasm.call, ...types.Array.fields.arr.leb128,
      wasm.local$get, ...j,
      wasm.i32$add,
      wasm.local$get, ...src,
      wasm.call, ...types.Array.fields.arr.leb128,
      wasm.local$get, ...i,
      wasm.i32$add,
      wasm.local$get, ...len,
      wasm.mem$prefix,
      wasm.mem$copy, 0, 0,
      wasm.local$get, ...dst
    ];
  }
);

funcs.build("refs_array_copy",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (src, i, dst, j, len) {
    const idx = this.local(wasm.i32);
    return [
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...len,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...dst,
          wasm.local$get, ...j,
          wasm.local$get, ...idx,
          wasm.i32$add,
          wasm.local$get, ...src,
          wasm.local$get, ...i,
          wasm.local$get, ...idx,
          wasm.i32$add,
          wasm.call, ...funcs.uleb128.refs_array_get,
          wasm.call, ...funcs.uleb128.refs_array_set,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...idx,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...dst
    ];
  }
);

funcs.build("refs_array_fit",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (len, idx) {
    return [
      wasm.local$get, ...len,
      wasm.local$get, ...idx,
      wasm.i32$gt_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...len,
      wasm.else,
        wasm.local$get, ...idx,
        wasm.i32$const, 1,
        wasm.i32$add,
      wasm.end,
      wasm.call, ...funcs.uleb128.refs_array_by_length
    ];
  }
);

funcs.build("array_push_i32",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (src, val) {
    const len = this.local(wasm.i32);
    return [
      wasm.local$get, ...src,
      wasm.i32$const, 0,
      wasm.local$get, ...src,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$tee, ...len,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.call, ...funcs.uleb128.array_by_length,
      wasm.i32$const, 0,
      wasm.local$get, ...len,
      wasm.i32$const, 2,
      wasm.i32$shl,
      wasm.call, ...funcs.uleb128.array_copy,
      wasm.local$get, ...len,
      wasm.local$get, ...val,
      wasm.call, ...funcs.uleb128.array_set_i32,
    ];
  }
);

funcs.build("refs_array_fit_and_copy",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (src, idx) {
    const len = this.local(wasm.i32);
    return [
      wasm.local$get, ...src,
      wasm.i32$const, 0,
      wasm.local$get, ...src,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$tee, ...len,
      wasm.local$get, ...idx,
      wasm.call, ...funcs.uleb128.refs_array_fit,
      wasm.i32$const, 0,
      wasm.local$get, ...len,
      wasm.call, ...funcs.uleb128.refs_array_copy
    ];
  }
);

funcs.build("refs_array_clone",
  [wasm.i32], [wasm.i32], {},
  function (src) {
    const len = this.local(wasm.i32);
    return [
      wasm.local$get, ...src,
      wasm.i32$const, 0,
      wasm.local$get, ...src,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$tee, ...len,
      wasm.call, ...funcs.uleb128.refs_array_by_length,
      wasm.i32$const, 0,
      wasm.local$get, ...len,
      wasm.call, ...funcs.uleb128.refs_array_copy
    ];
  }
);

compile();

const empty_refs_array = comp.refs_array_by_length(0);

/*----*\
|      |
| Atom |
|      |
\*----*/

function new_atom (val) {
  const atom = comp.Atom(val, 0);
  comp.inc_refs(val);
  return atom;
}

funcs.build("swap_lock",
  [wasm.i32], [], {},
  function (mutex_addr) {
    return [
      wasm.loop, wasm.void,
        wasm.local$get, ...mutex_addr,
        wasm.i32$const, 0,
        wasm.i32$const, 1,
        wasm.atomic$prefix,
        wasm.i32$atomic$rmw$cmpxchg, 2, 0,
        wasm.if, wasm.void,
          wasm.local$get, ...mutex_addr,
          wasm.i32$const, 1,
          wasm.i64$const, ...sleb128i64(-1n),
          wasm.atomic$prefix,
          wasm.memory$atomic$wait32, 2, 0,
          wasm.drop,
          wasm.br, 1,
        wasm.end,
      wasm.end
    ];
  }
);

funcs.build("swap_unlock",
  [wasm.i32], [], {},
  function (mutex_addr) {
    return [
      wasm.local$get, ...mutex_addr,
      wasm.i32$const, 0,
      wasm.atomic$prefix,
      wasm.i32$atomic$store, 2, 0,
      wasm.local$get, ...mutex_addr,
// todo: how many wake?
      wasm.i32$const, 1,
      wasm.atomic$prefix,
      wasm.memory$atomic$notify, 2, 0,
      wasm.drop
    ];
  }
);

/*
const atom_reset = func_builder(function (func) {
  const atom = func.param(wasm.i32),
        val = func.param(wasm.i32),
        mutex = func.local(wasm.i32),
        data = func.local(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...atom,
// todo: address getter
    wasm.i32$const, 12,
    wasm.i32$add,
    wasm.local$tee, ...mutex,
    wasm.call, ...swap_lock.func_idx_leb128,
// todo: reinstate setters, use here
    wasm.local$get, ...atom,
    wasm.i32$const, 8,
    wasm.i32$add,
    wasm.local$tee, ...data,
    wasm.local$get, ...data,
    wasm.i32$load, 2, 0,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...val,
    wasm.call, ...inc_refs.func_idx_leb128,
    wasm.atomic$prefix,
    wasm.i32$atomic$store, 2, 0,
    wasm.local$get, ...mutex,
    wasm.call, ...swap_unlock.func_idx_leb128,
    wasm.local$get, ...val
  );
});
*/

funcs.build("atom_swap_lock",
// todo: need to export?
  [wasm.i32], [wasm.i32], { export: true },
  function (atom) {
    return [
      // mutex
      wasm.local$get, ...atom,
      wasm.i32$const, ...sleb128i32(types.Atom.fields.mutex.offset),
      wasm.i32$add,
      wasm.call, ...funcs.uleb128.swap_lock,
      wasm.local$get, ...atom,
      wasm.call, ...types.Atom.fields.data.leb128
    ];
  }
);

funcs.build("atom_swap_unlock",
  [wasm.i32], [wasm.i32], {},
  function (atom) {
    return [
      // mutex
      wasm.local$get, ...atom,
      wasm.i32$const, ...sleb128i32(types.Atom.fields.mutex.offset),
      wasm.i32$add,
      wasm.call, ...funcs.uleb128.swap_unlock,
      wasm.i32$const, 1
    ];
  }
);

// called when atom is already locked
funcs.build("atom_swap_set",
  [wasm.i32, wasm.i32], [wasm.i32], { export: true },
  function (atom, val) {
    const data = this.local(wasm.i32);
    return [
      wasm.local$get, ...atom,
      wasm.i32$const, ...sleb128i32(types.Atom.fields.data.offset),
      wasm.i32$add,
      wasm.local$tee, ...data,
      wasm.local$get, ...data,
      wasm.atomic$prefix,
      wasm.i32$atomic$load, 2, 0,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.atomic$prefix,
      wasm.i32$atomic$store, 2, 0,
      wasm.local$get, ...atom,
      wasm.i32$const, ...sleb128i32(types.Atom.fields.mutex.offset),
      wasm.i32$add,
      wasm.call, ...funcs.uleb128.swap_unlock,
      wasm.local$get, ...val
    ];
  }
);

funcs.build("atom_deref",
  [wasm.i32], [wasm.i32], {},
  function (atom) {
    return [
      wasm.local$get, ...atom,
      wasm.i32$const, ...sleb128i32(types.Atom.fields.data.offset),
      wasm.i32$add,
      wasm.atomic$prefix,
      wasm.i32$atomic$load, 2, 0
    ];
  }
);

/*
const watch = func_builder(function (func) {
  const atom = func.param(wasm.i32),
        fn = func.param(wasm.i32),
        thread_port = func.local(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.call, ...start_thread.func_idx_leb128,
    wasm.local$tee, ...thread_port,
    wasm.local$get, ...atom,
    wasm.i32$store, 2, 0,
    wasm.local$get, ...thread_port,
    wasm.i32$const, 1,
    wasm.atomic$prefix,
    wasm.memory$atomic$notify, 2, 0,
    wasm.drop,
    wasm.i32$const, 0
  );
});

const add_watch = func_builder(function (func) {
  const atom = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...atom,
    wasm.i32$const, 4,
    wasm.i32$add,
    wasm.i32$const, 1,
    wasm.i64$const, ...sleb128i64(-1n),
    wasm.atomic$prefix,
    wasm.memory$atomic$wait32, 2, 0,
  );
});
*/

impl_free(types.Atom, function (func) {
  const atom = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...atom,
    wasm.call, ...types.Atom.fields.data.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

/*----------*\
|            |
| TaggedData |
|            |
\*----------*/

impl_free(types.TaggedData, function (func) {
  const td = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...td,
    wasm.call, ...types.TaggedData.fields.tag.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...td,
    wasm.call, ...types.TaggedData.fields.data.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

/*--------*\
|          |
| Metadata |
|          |
\*--------*/

impl_free(types.Metadata, function (func) {
  const md = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...md,
    wasm.call, ...types.Metadata.fields.meta.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...md,
    wasm.call, ...types.Metadata.fields.data.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

/*----*\
|      |
| math |
|      |
\*----*/

funcs.build("safe_add_i32",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (x, y) {
    return [
      wasm.local$get, ...y,
      wasm.i32$const, ...sleb128i32(-1),
      wasm.local$get, ...x,
      wasm.i32$sub,
      wasm.i32$le_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...x,
        wasm.local$get, ...y,
        wasm.i32$add,
      wasm.else,
        wasm.i32$const, 0,
        wasm.i32$const, ...sleb128i32(cached_string("i32 overflow")),
        wasm.call, ...types.Exception.constr.leb128,
        wasm.throw, 0,
      wasm.end
    ];
  }
);

funcs.build("is_odd_i64",
  [wasm.i64], [wasm.i64], {},
  function (n) {
    return [
      wasm.local$get, ...n,
      wasm.i64$const, 1,
      wasm.i64$and
    ];
  }
);

// https://en.wikipedia.org/wiki/Exponentiation_by_squaring
funcs.build("pow",
  [wasm.f64, wasm.i64], [wasm.f64], {},
  function (x, n) {
    const r = this.local(wasm.f64);
    return [
      wasm.loop, wasm.f64,
        wasm.local$get, ...n,
        wasm.i64$const, 0,
        wasm.i64$lt_s,
        wasm.if, wasm.f64,
          wasm.f64$const, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f, // 1
          wasm.local$get, ...x,
          wasm.f64$div,
          wasm.local$set, ...x,
          wasm.local$get, ...n,
          wasm.i64$const, ...sleb128i64(-1n),
          wasm.i64$mul,
          wasm.local$set, ...n,
          wasm.br, 1,
        wasm.else,
          wasm.local$get, ...n,
          wasm.i64$const, 0,
          wasm.i64$eq,
          wasm.if, wasm.f64,
            wasm.f64$const, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f, // 1
          wasm.else,
            wasm.local$get, ...n,
            wasm.i64$const, 1,
            wasm.i64$eq,
            wasm.if, wasm.f64,
              wasm.local$get, ...x,
            wasm.else,
              wasm.local$get, ...x,
              wasm.local$get, ...x,
              wasm.f64$mul,
              wasm.local$set, ...x,
              wasm.local$get, ...n,
              wasm.call, ...funcs.uleb128.is_odd_i64,
              wasm.local$get, ...n,
              wasm.i64$const, 1,
              wasm.i64$shr_u,
              wasm.local$set, ...n,
              wasm.br, 3,
              wasm.local$set, ...r,
              // if odd
              wasm.if, wasm.f64,
                wasm.local$get, ...x,
                wasm.local$get, ...r,
                wasm.f64$mul,
              wasm.else,
                wasm.local$get, ...r,
              wasm.end,
            wasm.end,
          wasm.end,
        wasm.end,
      wasm.end
    ];
  }
);

/*---*\
|     |
| Int |
|     |
\*---*/

funcs.build("i64_to_string",
  [wasm.i64], [wasm.i32], { comp: true },
  function (num) {
    const arr = this.local(wasm.i32),
          len = this.local(wasm.i32),
          idx = this.local(wasm.i32);
    return [
      wasm.i32$const, 0,
      wasm.call, ...funcs.uleb128.array_by_length,
      wasm.local$set, ...arr,
      wasm.loop, wasm.void,
        wasm.local$get, ...arr,
        wasm.local$get, ...arr,
        wasm.i32$const, 0,
        wasm.local$get, ...len,
        wasm.local$tee, ...idx,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.local$tee, ...len,
        wasm.i32$const, 4,
        wasm.call, ...funcs.uleb128.i32_div_ceil,
        wasm.call, ...funcs.uleb128.array_by_length,
        wasm.local$tee, ...arr,
        wasm.i32$const, 1,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.array_copy,
        wasm.i32$const, 0,
        wasm.local$get, ...num,
        wasm.i64$const, 10,
        wasm.i64$rem_u,
        wasm.i32$wrap_i64,
        wasm.i32$const, ...sleb128i32(48),
        wasm.i32$add,
        wasm.call, ...funcs.uleb128.array_set_i8,
        wasm.local$set, ...arr,
        wasm.call, ...free.func_idx_leb128,
        wasm.local$get, ...num,
        wasm.i64$const, 10,
        wasm.i64$div_u,
        wasm.local$tee, ...num,
        wasm.i32$wrap_i64,
        wasm.br_if, 0,
      wasm.end,
      wasm.local$get, ...arr,
      wasm.local$get, ...len,
      wasm.call, ...types.String.constr.leb128
    ];
  }
);

/*------------------*\
|                    |
| comp func wrappers |
|                    |
\*------------------*/

function wrap_result_i32_to_int (func, next) {
  return [
    ...next,
    wasm.i64$extend_i32_u,
    wasm.call, ...types.Int.constr.leb128
  ];
}

function wrap_result_i32_to_i64 (func, next) {
  return [
    ...next,
    wasm.i64$extend_i32_u
  ];
}

function wrap_result_i32_to_bool (func, next) {
  const out = func.local(wasm.i32);
  return [
    ...next,
    wasm.local$tee, ...out,
    wasm.if, wasm.i32,
      wasm.local$get, ...out,
      wasm.i32$const, ...sleb128i32(comp_false),
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...out,
      wasm.else,
        wasm.i32$const, ...sleb128i32(comp_true),
      wasm.end,
    wasm.else,
      wasm.i32$const, ...sleb128i32(comp_false),
    wasm.end
  ];
}

function wrap_args_int_to_i32 (idxs) {
  return function (func, next) {
    const code = [];
    for (let i = 0; i < idxs.length; i++) {
      code.push(
        wasm.local$get, idxs[i],
        wasm.call, ...types.Int.fields.value.leb128,
        wasm.i32$wrap_i64,
        wasm.local$set, idxs[i]
      );
    }
    return [...code, ...next];
  };
}

/*------*\
|        |
| String |
|        |
\*------*/

impl_free(types.String, function (func) {
  const str = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...str,
    wasm.call, ...types.String.fields.arr.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

impl_free(types.File, function (func) {
  const fstr = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...fstr,
    wasm.call, ...file_close.func_idx_leb128,
    wasm.i32$const, 1
  );
});

const string_length = pre_new_method(
  "string_length", 1, 0, 0, wasm.i32,
  { comp: [wrap_result_i32_to_int] }
);

string_length.implement(types.String, types.String.fields.length.func_idx);
string_length.implement(types.File, file_length.func_idx);

// converts segment of File to String in situations when
// we wouldn't need to call substring on a String
const get_string_chunk = pre_new_method(null, 3, 0, 0, wasm.i32, {});

get_string_chunk.implement(types.String, function (str) {
  return [
    wasm.local$get, ...str,
    wasm.call, ...inc_refs.func_idx_leb128
  ];
});

get_string_chunk.implement(types.File, file_get_string_chunk.func_idx);

const substring = pre_new_method(
  "substring", 3, 0, 0, wasm.i32, {
    comp: [wrap_args_int_to_i32([1, 2])]
  }
);

// todo: test that len < str.len
substring.implement(types.String, function (str, start, len) {
  return [
    wasm.local$get, ...str,
    wasm.call, ...types.String.fields.arr.leb128,
    wasm.local$get, ...start,
    // length is meaningless since array has to be multiples of four
    // and string uses its own length for iterating
    wasm.i32$const, 0,
    wasm.call, ...funcs.uleb128.subarray,
    wasm.local$get, ...len,
    wasm.call, ...types.String.constr.leb128
  ];
});

substring.implement(types.File, file_get_string_chunk.func_idx);

funcs.build("substring_to_end",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (str, idx) {
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.local$get, ...str,
      wasm.call, ...types.String.fields.length.leb128,
      wasm.local$get, ...idx,
      wasm.i32$sub,
      wasm.call, ...substring.func_idx_leb128
    ];
  }
);

// todo: test that end < start
funcs.build("substring_until",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (str, start, end) {
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...start,
      wasm.local$get, ...end,
      wasm.local$get, ...start,
      wasm.i32$sub,
      wasm.call, ...substring.func_idx_leb128
    ];
  }
);

funcs.build("get_codepoint",
  [wasm.i32, wasm.i32], [wasm.i32, wasm.i32], {},
  function (str, idx) {
    const arr = this.local(wasm.i32),
          org = this.local(wasm.i32),
          len = this.local(wasm.i32),
          num_bytes = this.local(wasm.i32),
          byt = this.local(wasm.i32),
          chr = this.local(wasm.i32),
          mask1 = 0b00011111,
          mask2 = 0b00001111,
          mask3 = 0b00000111;
    return [
      wasm.local$get, ...idx,
      wasm.local$tee, ...org,
      wasm.local$get, ...str,
      wasm.call, ...string_length.func_idx_leb128,
      wasm.local$tee, ...len,
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.i32$const, 4,
      // this converts file to string
      wasm.call, ...substring.func_idx_leb128,
      wasm.local$tee, ...str,
      wasm.call, ...types.String.fields.arr.leb128,
      wasm.local$set, ...arr,
      wasm.i32$const, 0,
      wasm.local$set, ...idx,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.array_get_i8,
        wasm.local$tee, ...byt,
        wasm.i32$const, ...sleb128i32(128),
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...byt,
          wasm.local$set, ...chr,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...idx,
        wasm.else,
          wasm.local$get, ...byt,
          wasm.i32$const, 5,
          wasm.i32$shr_u,
          wasm.i32$const, 0b110, 
          wasm.i32$eq,
          wasm.if, wasm.void,
            wasm.local$get, ...byt,
            wasm.i32$const, mask1,
            wasm.i32$and,
            wasm.local$set, ...chr,
            wasm.i32$const, 1,
            wasm.local$set, ...num_bytes,
          wasm.else,
            wasm.local$get, ...byt,
            wasm.i32$const, 4,
            wasm.i32$shr_u,
            wasm.i32$const, 0b1110,
            wasm.i32$eq,
            wasm.if, wasm.void,
              wasm.local$get, ...byt,
              wasm.i32$const, mask2,
              wasm.i32$and,
              wasm.local$set, ...chr,
              wasm.i32$const, 2,
              wasm.local$set, ...num_bytes,
            wasm.else,
              wasm.local$get, ...byt,
              wasm.i32$const, 3,
              wasm.i32$shr_u,
              wasm.i32$const, 0b11110,
              wasm.i32$eq,
              wasm.if, wasm.void,
                wasm.local$get, ...byt,
                wasm.i32$const, mask3,
                wasm.i32$and,
                wasm.local$set, ...chr,
                wasm.i32$const, 3,
                wasm.local$set, ...num_bytes,
              wasm.else,
                // todo: throw error
              wasm.end,
            wasm.end,
          wasm.end,
          wasm.local$get, ...idx,
          wasm.local$get, ...num_bytes,
          wasm.i32$add,
          wasm.local$get, ...len,
          wasm.i32$lt_u,
          wasm.if, wasm.void,
          // todo: else throw error
            wasm.loop, wasm.void,
              wasm.local$get, ...num_bytes,
              wasm.if, wasm.void,
                wasm.local$get, ...chr,
                wasm.i32$const, 6,
                wasm.i32$shl,
                wasm.local$get, ...arr,
                wasm.local$get, ...idx,
                wasm.i32$const, 1,
                wasm.i32$add,
                wasm.local$tee, ...idx,
                wasm.call, ...funcs.uleb128.array_get_i8,
                wasm.i32$const, 0b00111111,
                wasm.i32$and,
                wasm.i32$or,
                wasm.local$set, ...chr,
                wasm.local$get, ...num_bytes,
                wasm.i32$const, 1,
                wasm.i32$sub,
                wasm.local$set, ...num_bytes,
                wasm.br, 1,
              wasm.else,
                wasm.local$get, ...idx,
                wasm.i32$const, 1,
                wasm.i32$add,
                wasm.local$set, ...idx,
              wasm.end,
            wasm.end,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.local$get, ...str,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$get, ...chr,
      wasm.local$get, ...org,
      wasm.local$get, ...idx,
      wasm.i32$add
    ];
  }
);

const index_of_codepoint = pre_new_method(
  "index_of_codepoint", 2, 0, 0, wasm.i32, {
    comp: [
      wrap_args_int_to_i32([1]),
      wrap_result_i32_to_int
    ]
  }
);

index_of_codepoint.implement(types.String, function (str, cdp) {
  const idx = this.local(wasm.i32),
        tmp = this.local(wasm.i32),
        len = this.local(wasm.i32),
        out = this.local(wasm.i32);
  return [
    wasm.i32$const, ...sleb128i32(-1),
    wasm.local$set, ...out,
    wasm.local$get, ...str,
    wasm.call, ...types.String.fields.length.leb128,
    wasm.local$set, ...len,
    wasm.loop, wasm.void,
      wasm.local$get, ...idx,
      wasm.local$get, ...len,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.get_codepoint,
        wasm.local$set, ...tmp,
        wasm.local$get, ...cdp,
        wasm.i32$eq,
        wasm.if, wasm.void,
          wasm.local$get, ...idx,
          wasm.local$set, ...out,
        wasm.else,
          wasm.local$get, ...tmp,
          wasm.local$set, ...idx,
          wasm.br, 2,
        wasm.end,
      wasm.end,
    wasm.end,
    wasm.local$get, ...out,
  ];
});

funcs.build("new_string",
  [wasm.i32], [wasm.i32], {},
  function (len) {
    return [
      // ceiling of len/4
      wasm.local$get, ...len,
      wasm.i32$const, 4,
      wasm.call, ...funcs.uleb128.i32_div_ceil,
      wasm.call, ...funcs.uleb128.array_by_length,
      wasm.local$get, ...len,
      wasm.call, ...types.String.constr.leb128,
    ];
  }
);

// todo: confirm str2 is string
funcs.build("concat_str",
  [wasm.i32, wasm.i32], [wasm.i32], { comp: true },
  function (str1, str2) {
    const len1 = this.local(wasm.i32),
          len2 = this.local(wasm.i32),
          arr = this.local(wasm.i32),
          out = this.local(wasm.i32);
    return [
      wasm.local$get, ...str1,
      wasm.call, ...types.String.fields.length.leb128,
      wasm.local$tee, ...len1,
      wasm.local$get, ...str2,
      wasm.call, ...types.String.fields.length.leb128,
      wasm.local$tee, ...len2,
      wasm.call, ...funcs.uleb128.safe_add_i32,
      wasm.call, ...funcs.uleb128.new_string,
      wasm.local$tee, ...out,
      wasm.call, ...types.String.fields.arr.leb128,
      wasm.call, ...types.Array.fields.arr.leb128,
      wasm.local$tee, ...arr,
      wasm.local$get, ...str1,
      wasm.call, ...types.String.fields.arr.leb128,
      wasm.call, ...types.Array.fields.arr.leb128,
      wasm.local$get, ...len1,
      wasm.mem$prefix,
      wasm.mem$copy, 0, 0,
      wasm.local$get, ...arr,
      wasm.local$get, ...len1,
      wasm.i32$add,
      wasm.local$get, ...str2,
      wasm.call, ...types.String.fields.arr.leb128,
      wasm.call, ...types.Array.fields.arr.leb128,
      wasm.local$get, ...len2,
      wasm.mem$prefix,
      wasm.mem$copy, 0, 0,
      wasm.local$get, ...out
    ];
  }
);

/*------*\
|        |
| Object |
|        |
\*------*/

impl_free(types.Object, function (func) {
  const obj = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...obj,
    wasm.call, ...types.Object.fields.address.leb128,
    wasm.call, ...free_ref.func_idx_leb128,
    wasm.i32$const, 1
  );
});

/*------------*\
|              |
| coll methods |
|              |
\*------------*/

const get = pre_new_method("get", 3, 0, 0, wasm.i32, { comp: true }),
      assoc = pre_new_method("assoc", 3, 0, 0, wasm.i32, { comp: true }),
      conj = pre_new_method("conj", 2, 0, 0, wasm.i32, { comp: true }),
      nth = pre_new_method("nth", 3, 0, 0, wasm.i32, {
        comp: [wrap_args_int_to_i32([1])]
      }),
      first = pre_new_method("first", 1, 0, 0, wasm.i32, { comp: true }),
      rest = pre_new_method("rest", 1, 0, 0, wasm.i32, { comp: true }),
      count = pre_new_method("count", 1, 0, 0, wasm.i32, {
        comp: [wrap_result_i32_to_int]
      }),
      to_seq = pre_new_method("to_seq", 1, 0, 0, wasm.i32, { comp: true });

/*------*\
|        |
| Vector |
|        |
\*------*/

const empty_vector = comp.Vector(0, 5, empty_refs_array, empty_refs_array);
      
impl_free(types.Vector, function (func) {
  const vec = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.count.leb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.root.leb128,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.tail.leb128,
      wasm.call, ...free.func_idx_leb128,
      wasm.i32$const, 1,
    wasm.else,
      wasm.i32$const, 0,
    wasm.end
  );
});

funcs.build("new_path",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (level, node) {
    return [
      // new_path is called when a new vector is being created
      // the tail (node) will now be referenced by two vectors
      wasm.local$get, ...node,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.drop,
      wasm.loop, wasm.i32,
        wasm.local$get, ...level,
        wasm.if, wasm.i32,
          wasm.i32$const, 1,
          wasm.call, ...funcs.uleb128.refs_array_by_length,
          wasm.i32$const, 0,
          wasm.local$get, ...node,
          // new nodes are only referenced here so don't need inc_refs
          wasm.call, ...funcs.uleb128.refs_array_set_no_inc,
          wasm.local$set, ...node,
          wasm.local$get, ...level,
          wasm.i32$const, 5,
          wasm.i32$sub,
          wasm.local$set, ...level,
          wasm.br, 1,
        wasm.else,
          wasm.local$get, ...node,
        wasm.end,
      wasm.end
    ];
  }
);

funcs.build("push_tail",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (vec, level, parent, tail) {
    const arr = this.local(wasm.i32),
          subidx = this.local(wasm.i32),
          child = this.local(wasm.i32);
    return [
      // first two args to refs_array_copy
      wasm.local$get, ...parent,
      wasm.i32$const, 0,
  
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.count.leb128,
      wasm.i32$const, 1,
      wasm.i32$sub,
      wasm.local$get, ...level,
      wasm.i32$shr_u,
      wasm.i32$const, 31,
      wasm.i32$and,
      wasm.local$tee, ...subidx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.call, ...funcs.uleb128.refs_array_by_length,
  
      // last two args to refs_array_copy
      wasm.i32$const, 0,
      wasm.local$get, ...parent,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.call, ...types.Array.fields.length.leb128,
  
      // inc_refs because contents will be shared
      wasm.call, ...funcs.uleb128.refs_array_copy,
      wasm.local$tee, ...arr,
  
      // second arg to refs_array_set_no_inc
      wasm.local$get, ...subidx,
  
      wasm.i32$const, 5,
      wasm.local$get, ...level,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...tail,
        // tail is now shared
        wasm.call, ...inc_refs.func_idx_leb128,
      wasm.else,
        wasm.local$get, ...level,
        wasm.i32$const, 5,
        wasm.i32$sub,
        wasm.local$set, ...level,
        wasm.local$get, ...arr,
        wasm.local$get, ...subidx,
        wasm.call, ...funcs.uleb128.refs_array_get,
        wasm.local$tee, ...child,
        wasm.if, wasm.i32,
          wasm.local$get, ...vec,
          wasm.local$get, ...level,
          wasm.local$get, ...child,
          wasm.local$get, ...tail,
          // no inc_refs because func returns new array
          // contents of new array are inc_ref'd above
          wasm.call, ...this.func_idx_leb128,
        wasm.else,
          wasm.local$get, ...level,
          wasm.local$get, ...tail,
          // tail is inc_ref'd inside new_path
          wasm.call, ...funcs.uleb128.new_path,
        wasm.end,
      wasm.end,
  
      wasm.call, ...funcs.uleb128.refs_array_set_no_inc
    ];
  }
);

funcs.build("tail_off",
  [wasm.i32], [wasm.i32], {},
  function (vec) {
    const cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.count.leb128,
      wasm.local$tee, ...cnt,
      wasm.i32$const, 32,
      wasm.i32$lt_u,
      wasm.if, wasm.i32,
        wasm.i32$const, 0,
      wasm.else,
        wasm.local$get, ...cnt,
        wasm.i32$const, 1,
        wasm.i32$sub,
        wasm.i32$const, 5,
        wasm.i32$shr_u,
        wasm.i32$const, 5,
        wasm.i32$shl,
      wasm.end
    ];
  }
);

conj.implement(types.Vector, function (vec, val) {
  const cnt = this.local(wasm.i32),
        shift = this.local(wasm.i32),
        root = this.local(wasm.i32),
        len = this.local(wasm.i32),
        tail = this.local(wasm.i32);
  return [
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.tail.leb128,
    wasm.local$set, ...tail,
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.shift.leb128,
    wasm.local$set, ...shift,
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.root.leb128,
    wasm.local$set, ...root,
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.count.leb128,
    wasm.local$tee, ...cnt,
    wasm.local$get, ...vec,
    wasm.call, ...funcs.uleb128.tail_off,
    wasm.i32$sub,
    wasm.i32$const, 32,
    wasm.i32$lt_u,
    wasm.if, wasm.void,
      // tail is not full, so just put val there
      wasm.local$get, ...tail,
      wasm.i32$const, 0,
      wasm.local$get, ...tail,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$tee, ...len,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.call, ...funcs.uleb128.refs_array_by_length,
      wasm.i32$const, 0,
      wasm.local$get, ...len,
      // inc_refs needed for shared contents of tails
      wasm.call, ...funcs.uleb128.refs_array_copy,
      wasm.local$get, ...len,
      wasm.local$get, ...val,
      wasm.call, ...funcs.uleb128.refs_array_set,
      wasm.local$set, ...tail,
      // root is unchanged, so it will be shared
      wasm.local$get, ...root,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.drop,
    wasm.else,
      wasm.local$get, ...cnt,
      wasm.i32$const, 5,
      wasm.i32$shr_u,
      wasm.i32$const, 1,
      wasm.local$get, ...shift,
      wasm.i32$shl,
      wasm.i32$gt_u,
      wasm.if, wasm.void,
        // tree is full, so add a level
        wasm.i32$const, 2,
        wasm.call, ...funcs.uleb128.refs_array_by_length,
        wasm.i32$const, 0,
        wasm.local$get, ...root,
        // root is now shared, so inc_refs needed
        wasm.call, ...funcs.uleb128.refs_array_set,
        wasm.i32$const, 1,
        wasm.local$get, ...shift,
        wasm.local$get, ...tail,
        // tail is inc_ref'd in new_path
        wasm.call, ...funcs.uleb128.new_path,
        // new_path is new, so no inc_refs
        wasm.call, ...funcs.uleb128.refs_array_set_no_inc,
        wasm.local$set, ...root,
        wasm.local$get, ...shift,
        wasm.i32$const, 5,
        wasm.i32$add,
        wasm.local$set, ...shift,
      wasm.else,
        // tree is not full, so just add tail
        wasm.local$get, ...vec,
        wasm.local$get, ...shift,
        wasm.local$get, ...root,
        wasm.local$get, ...tail,
        // push_tail copies contents of root into new array,
        // so root will not be shared
        wasm.call, ...funcs.uleb128.push_tail,
        wasm.local$set, ...root,
      wasm.end,
      wasm.i32$const, 1,
      wasm.call, ...funcs.uleb128.refs_array_by_length,
      wasm.i32$const, 0,
      wasm.local$get, ...val,
      wasm.call, ...funcs.uleb128.refs_array_set,
      wasm.local$set, ...tail,
    wasm.end,
    wasm.local$get, ...cnt,
    wasm.i32$const, 1,
    wasm.i32$add,
    wasm.local$get, ...shift,
    wasm.local$get, ...root,
    wasm.local$get, ...tail,
    wasm.call, ...types.Vector.constr.leb128
  ];
});

funcs.build("unchecked_array_for",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (vec, n) {
    const node = this.local(wasm.i32),
          level = this.local(wasm.i32);
    return [
      wasm.local$get, ...n,
      wasm.local$get, ...vec,
      wasm.call, ...funcs.uleb128.tail_off,
      wasm.i32$ge_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.tail.leb128,
      wasm.else,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.root.leb128,
        wasm.local$set, ...node,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.shift.leb128,
        wasm.local$set, ...level,
        wasm.loop, wasm.i32,
          wasm.local$get, ...level,
          wasm.if, wasm.i32,
            wasm.local$get, ...node,
            wasm.local$get, ...n,
            wasm.local$get, ...level,
            wasm.i32$shr_u,
            wasm.i32$const, ...sleb128i32(0x01f),
            wasm.i32$and,
            wasm.call, ...funcs.uleb128.refs_array_get,
            wasm.local$set, ...node,
            wasm.local$get, ...level,
            wasm.i32$const, 5,
            wasm.i32$sub,
            wasm.local$set, ...level,
            wasm.br, 1,
          wasm.else,
            wasm.local$get, ...node,
          wasm.end,
        wasm.end,
      wasm.end
    ];
  }
);

nth.implement(types.Vector, function (vec, n, not_found) {
  return [
    wasm.local$get, ...n,
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.count.leb128,
    wasm.i32$lt_u,
    wasm.if, wasm.i32,
      wasm.local$get, ...vec,
      wasm.local$get, ...n,
      wasm.call, ...funcs.uleb128.unchecked_array_for,
      wasm.local$get, ...n,
      wasm.i32$const, ...sleb128i32(0x01f),
      wasm.i32$and,
      wasm.call, ...funcs.uleb128.refs_array_get,
    wasm.else,
      wasm.local$get, ...not_found,
    wasm.end
  ];
});

funcs.build("do_assoc",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (vec, level, node, idx, val) {
    const subidx = this.local(wasm.i32);
    return [
      wasm.local$get, ...node,
      // inc_refs for shared contents of arrays
      wasm.call, ...funcs.uleb128.refs_array_clone,
      wasm.local$set, ...node,
      wasm.local$get, ...level,
      wasm.if, wasm.i32,
        wasm.local$get, ...node,
  
        wasm.local$get, ...idx,
        wasm.local$get, ...level,
        wasm.i32$shr_u,
        wasm.i32$const, ...sleb128i32(0x01f),
        wasm.i32$and,
        wasm.local$tee, ...subidx,
  
        wasm.local$get, ...vec,
        wasm.local$get, ...level,
        wasm.i32$const, 5,
        wasm.i32$sub,
        wasm.local$get, ...node,
        wasm.local$get, ...subidx,
        wasm.call, ...funcs.uleb128.refs_array_get,
        wasm.local$get, ...idx,
        wasm.local$get, ...val,
        wasm.call, ...this.func_idx_leb128,
  
        // recursively created node is new, so no inc_refs
        wasm.call, ...funcs.uleb128.refs_array_set_no_inc,
      wasm.else,
        wasm.local$get, ...node,
        wasm.local$get, ...idx,
        wasm.i32$const, ...sleb128i32(0x01f),
        wasm.i32$and,
        wasm.local$get, ...val,
        wasm.call, ...funcs.uleb128.refs_array_set,
      wasm.end
    ];
  }
);

// todo: verify that n <= vec count
assoc.implement(types.Vector, function (vec, n, val) {
  const cnt = this.local(wasm.i32),
        shift = this.local(wasm.i32),
        root = this.local(wasm.i32),
        tail = this.local(wasm.i32);
  return [
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.count.leb128,
    wasm.local$tee, ...cnt,
    wasm.local$get, ...n,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...vec,
      wasm.local$get, ...val,
      wasm.call, ...conj.func_idx_leb128,
    wasm.else,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.shift.leb128,
      wasm.local$set, ...shift,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.root.leb128,
      wasm.local$set, ...root,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.tail.leb128,
      wasm.local$set, ...tail,
      wasm.local$get, ...vec,
      wasm.call, ...funcs.uleb128.tail_off,
      wasm.local$get, ...n,
      wasm.i32$le_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...cnt,
        wasm.local$get, ...shift,
        wasm.local$get, ...root,
        // root is now shared
        wasm.call, ...inc_refs.func_idx_leb128,
        wasm.local$get, ...tail,
        wasm.call, ...funcs.uleb128.refs_array_clone,
        wasm.local$get, ...n,
        wasm.i32$const, ...sleb128i32(0x01f),
        wasm.i32$and,
        wasm.local$get, ...val,
        wasm.call, ...funcs.uleb128.refs_array_set,
        wasm.call, ...types.Vector.constr.leb128,
      wasm.else,
        wasm.local$get, ...cnt,
        wasm.local$get, ...shift,
        wasm.local$get, ...vec,
        wasm.local$get, ...shift,
        wasm.local$get, ...root,
        wasm.local$get, ...n,
        wasm.local$get, ...val,
        wasm.call, ...funcs.uleb128.do_assoc,
        wasm.local$get, ...tail,
        // tail is now shared
        wasm.call, ...inc_refs.func_idx_leb128,
        wasm.call, ...types.Vector.constr.leb128,
      wasm.end,
    wasm.end
  ];
});

count.implement(types.Vector, function (vec) {
  return [
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.count.leb128
  ];
});

funcs.build("vector_from_array",
  [wasm.i32], [wasm.i32], {},
  function (arr) {
    const cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$tee, ...cnt,
      wasm.i32$const, 32,
      wasm.i32$le_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...cnt,
        wasm.i32$const, 5,
        wasm.i32$const, ...sleb128i32(empty_refs_array),
        wasm.local$get, ...arr,
        wasm.call, ...types.Vector.constr.leb128,
      wasm.else,
// todo: handle when more than 32
        wasm.i32$const, 0,
      wasm.end
    ];
  }
);

/*----*\
|      |
| hash |
|      |
\*----*/

// https://github.com/hideo55/node-murmurhash3/blob/master/src/MurmurHash3.cpp
// https://github.com/scala/scala/blob/2.13.x/src/library/scala/util/hashing/MurmurHash3.scala

funcs.build("m3_mix_k",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (h, k) {
    return [
      wasm.local$get, ...h,
      wasm.local$get, ...k,
      wasm.i32$const, ...sleb128i32(0xcc9e2d51),
      wasm.i32$mul,
      wasm.i32$const, 15,
      wasm.i32$rotl,
      wasm.i32$const, ...sleb128i32(0x1b873593),
      wasm.i32$mul,
      wasm.i32$xor,
    ];
  }
);

funcs.build("m3_mix_h",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (h, k) {
    return [
      wasm.local$get, ...h,
      wasm.local$get, ...k,
      wasm.call, ...funcs.uleb128.m3_mix_k,
      wasm.i32$const, 13,
      wasm.i32$rotl,
      wasm.i32$const, 5,
      wasm.i32$mul,
      wasm.i32$const, ...sleb128i32(0xe6546b64),
      wasm.i32$add
    ];
  }
);

funcs.build("m3_fmix",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (h, len) {
    return [
      wasm.local$get, ...h,
      wasm.local$get, ...len,
      wasm.i32$xor,
      wasm.local$tee, ...h,
      wasm.local$get, ...h,
      wasm.i32$const, 16,
      wasm.i32$shr_u,
      wasm.i32$xor,
      wasm.i32$const, ...sleb128i32(0x85ebca6b),
      wasm.i32$mul,
      wasm.local$tee, ...h,
      wasm.local$get, ...h,
      wasm.i32$const, 13,
      wasm.i32$shr_u,
      wasm.i32$xor,
      wasm.i32$const, ...sleb128i32(0xc2b2ae35),
      wasm.i32$mul,
      wasm.local$tee, ...h,
      wasm.local$get, ...h,
      wasm.i32$const, 16,
      wasm.i32$shr_u,
      wasm.i32$xor
    ];
  }
);

/*
const hash_combine = func_builder(function (func) {
  const seed = func.param(wasm.i32),
        hash = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...seed,
    wasm.local$get, ...seed,
    wasm.i32$const, 2,
    wasm.i32$shr_s,
    wasm.local$get, ...seed,
    wasm.i32$const, 6,
    wasm.i32$shl,
    wasm.i32$add,
    wasm.i32$const, ...sleb128i32(0x9e3779b9),
    wasm.i32$add,
    wasm.local$get, ...hash,
    wasm.i32$add,
    wasm.i32$xor
  );
});
*/

funcs.build("hash_bytes",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, len) {
    const cnt = this.local(wasm.i32),
          idx = this.local(wasm.i32),
          hsh = this.local(wasm.i32);
    return [
      wasm.local$get, ...len,
      wasm.i32$const, 2,
      wasm.i32$shr_u,
      wasm.local$set, ...cnt,
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...hsh,
          wasm.local$get, ...arr,
          wasm.local$get, ...idx,
          wasm.call, ...funcs.uleb128.array_get_i32,
          wasm.call, ...funcs.uleb128.m3_mix_h,
          wasm.local$set, ...hsh,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...idx,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...len,
      wasm.i32$const, 3,
      wasm.i32$and,
      wasm.if, wasm.void,
        wasm.local$get, ...hsh,
        wasm.local$get, ...arr,
        wasm.local$get, ...cnt,
        wasm.call, ...funcs.uleb128.array_get_i32,
        wasm.call, ...funcs.uleb128.m3_mix_k,
        wasm.local$set, ...hsh,
      wasm.end,
      wasm.local$get, ...hsh,
      wasm.local$get, ...len,
      wasm.call, ...funcs.uleb128.m3_fmix
    ];
  }
);

const hash_id = function (val) {
  return [wasm.local$get, ...val];
}

const hash = pre_new_method("hash", 1, 0, 0, wasm.i32, {
  comp: [wrap_result_i32_to_int]
}, hash_id);

hash.implement(types.True, function () {
  return [wasm.i32$const, ...sleb128i32(1231)];
});

hash.implement(types.False, function () {
  return [wasm.i32$const, ...sleb128i32(1237)];
});

hash.implement(types.Int, function (i) {
  return [
    wasm.local$get, ...i,
    wasm.call, ...types.Int.fields.value.leb128,
    wasm.i32$wrap_i64
  ];
});

hash.implement(types.Float, function (f) {
  return [
    wasm.local$get, ...f,
    wasm.call, ...types.Float.fields.value.leb128,
    wasm.i32$trunc_f64_s
  ];
});
//  todo: handle infinity
//  (case o
//    ##Inf
//    2146435072
//    ##-Inf
//    -1048576
//    2146959360)

function caching_hash (...ops) {
  return function (val) {
    const slot = this.local(wasm.i32),
          h = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.i32$const, ...sleb128i32(types.Symbol.fields.hash.offset),
      wasm.i32$add,
      wasm.local$tee, ...slot,
      wasm.atomic$prefix,
      wasm.i32$atomic$load, 2, 0,
      wasm.local$tee, ...h,
      wasm.if, wasm.i32,
        wasm.local$get, ...h,
      wasm.else,
        ...ops,
        wasm.local$tee, ...h,
        wasm.local$get, ...slot,
        wasm.local$get, ...h,
        wasm.atomic$prefix,
        wasm.i32$atomic$store, 2, 0,
      wasm.end
    ];
  };
}

const hash_string = caching_hash(
  wasm.local$get, 0,
  wasm.call, ...types.String.fields.arr.leb128,
  wasm.local$get, 0,
  wasm.call, ...types.String.fields.length.leb128,
  wasm.call, ...funcs.uleb128.hash_bytes
);

hash.implement(types.String, hash_string);

// based on how Scala handles Tuple2
function impl_hash_symkw (which) {
  hash.implement(which, caching_hash(
    wasm.i32$const, 0,
    wasm.i32$const, ...sleb128i32(which.type_num),
    wasm.call, ...funcs.uleb128.m3_mix_h,
    wasm.local$get, 0,
    wasm.call, ...which.fields.namespace.leb128,
    wasm.call, ...hash.func_idx_leb128,
    wasm.call, ...funcs.uleb128.m3_mix_h,
    wasm.local$get, 0,
    wasm.call, ...which.fields.name.leb128,
    wasm.call, ...hash.func_idx_leb128,
    wasm.call, ...funcs.uleb128.m3_mix_h,
    wasm.i32$const, 2,
    wasm.call, ...funcs.uleb128.m3_fmix
  ));
}

impl_hash_symkw(types.Symbol);
impl_hash_symkw(types.Keyword);

/*--*\
|    |
| eq |
|    |
\*--*/

const equiv = pre_new_method(null, 2, 0, 0, wasm.i32, {}, function (a, b) {
  return [wasm.i32$const, 0];
});

funcs.build("string_matches",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (str1, str2) {
    const len = this.local(wasm.i32),
          idx = this.local(wasm.i32),
          cnt = this.local(wasm.i32),
          out = this.local(wasm.i32);
    return [
      wasm.local$get, ...str1,
      wasm.call, ...types.String.fields.arr.leb128,
      wasm.local$set, ...str1,
      wasm.local$get, ...str2,
      wasm.call, ...types.String.fields.length.leb128,
      wasm.local$tee, ...len,
      // divide by 8 because len is in bytes, but we will compare i64s
      wasm.i32$const, 3,
      wasm.i32$shr_u,
      wasm.local$set, ...cnt,
      wasm.local$get, ...str2,
      wasm.call, ...types.String.fields.arr.leb128,
      wasm.local$set, ...str2,
      wasm.i32$const, 1,
      wasm.local$set, ...out,
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...str1,
          wasm.local$get, ...idx,
          wasm.call, ...funcs.uleb128.array_get_i64,
          wasm.local$get, ...str2,
          wasm.local$get, ...idx,
          wasm.call, ...funcs.uleb128.array_get_i64,
          wasm.i64$eq,
          wasm.if, wasm.void,
            wasm.local$get, ...idx,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...idx,
            wasm.br, 2,
          wasm.else,
            wasm.i32$const, 0,
            wasm.local$set, ...out,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.local$get, ...out,
      wasm.if, wasm.void,
        wasm.local$get, ...idx,
        wasm.i32$const, 3,
        wasm.i32$shl,
        wasm.local$set, ...idx,
        wasm.loop, wasm.void,
          wasm.local$get, ...idx,
          wasm.local$get, ...len,
          wasm.i32$lt_u,
          wasm.if, wasm.void,
            wasm.local$get, ...str1,
            wasm.local$get, ...idx,
            wasm.call, ...funcs.uleb128.array_get_i8,
            wasm.local$get, ...str2,
            wasm.local$get, ...idx,
            wasm.call, ...funcs.uleb128.array_get_i8,
            wasm.i32$eq,
            wasm.if, wasm.void,
              wasm.local$get, ...idx,
              wasm.i32$const, 1,
              wasm.i32$add,
              wasm.local$set, ...idx,
              wasm.br, 2,
            wasm.else,
              wasm.i32$const, 0,
              wasm.local$set, ...out,
            wasm.end,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.local$get, ...out
    ];
  }
);

funcs.build("string_matches_from",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (str, sbstr, from) {
    const len = this.local(wasm.i32);
    return [
      wasm.local$get, ...str,
      wasm.call, ...string_length.func_idx_leb128,
      wasm.local$get, ...from,
      wasm.i32$sub,
      wasm.local$get, ...sbstr,
      wasm.call, ...string_length.func_idx_leb128,
      wasm.local$tee, ...len,
      wasm.i32$ge_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...str,
        wasm.local$get, ...from,
        wasm.local$get, ...len,
        wasm.call, ...substring.func_idx_leb128,
        wasm.local$tee, ...str,
        wasm.local$get, ...sbstr,
        wasm.local$get, ...from,
        wasm.local$get, ...len,
        wasm.call, ...get_string_chunk.func_idx_leb128,
        wasm.local$tee, ...sbstr,
        wasm.call, ...funcs.uleb128.string_matches,
        wasm.local$get, ...sbstr,
        wasm.call, ...free.func_idx_leb128,
        wasm.local$get, ...str,
        wasm.call, ...free.func_idx_leb128,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  }
);

// todo: make sure b is also string in comp
funcs.build("string_equiv",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (a, b) {
    const len = this.local(wasm.i32);
    return [
      wasm.local$get, ...a,
      wasm.call, ...string_length.func_idx_leb128,
      wasm.local$tee, ...len,
      wasm.local$get, ...b,
      wasm.call, ...string_length.func_idx_leb128,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...a,
        wasm.i32$const, 0,
        wasm.local$get, ...len,
        wasm.call, ...get_string_chunk.func_idx_leb128,
        wasm.local$tee, ...a,
        wasm.local$get, ...b,
        wasm.i32$const, 0,
        wasm.local$get, ...len,
        wasm.call, ...get_string_chunk.func_idx_leb128,
        wasm.local$tee, ...b,
        wasm.call, ...funcs.uleb128.string_matches,
        wasm.local$get, ...a,
        wasm.call, ...free.func_idx_leb128,
        wasm.local$get, ...b,
        wasm.call, ...free.func_idx_leb128,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  }
);

function hashed_equiv (equiv) {
  return function (a, b) {
    const ha = this.local(wasm.i32),
          hb = this.local(wasm.i32);
    return [
      wasm.local$get, ...a,
      wasm.i32$const, 8,
      wasm.i32$add,
      wasm.atomic$prefix,
      wasm.i32$atomic$load, 2, 0,
      wasm.local$tee, ...ha,
      wasm.if, wasm.i32,
        wasm.local$get, ...b,
        wasm.i32$const, 8,
        wasm.i32$add,
        wasm.atomic$prefix,
        wasm.i32$atomic$load, 2, 0,
        wasm.local$tee, ...hb,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end,
      wasm.if, wasm.i32,
        wasm.local$get, ...ha,
        wasm.local$get, ...hb,
        wasm.i32$eq,
      wasm.else,
        wasm.i32$const, 1,
      wasm.end,
      wasm.if, wasm.i32,
        wasm.local$get, ...a,
        wasm.local$get, ...b,
        wasm.call, ...equiv.func_idx_leb128,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  };
}

equiv.implement(types.String, hashed_equiv(funcs.built.string_equiv));
equiv.implement(types.File, hashed_equiv(funcs.built.string_equiv));

function equiv_by_field(type, field, op) {
  equiv.implement(type, function (a, b) {
    return [
      wasm.local$get, ...a,
      wasm.call, ...type.fields[field].leb128,
      wasm.local$get, ...b,
      wasm.call, ...type.fields[field].leb128,
      op
    ];
  });
}

equiv_by_field(types.Int, "value", wasm.i64$eq);
equiv_by_field(types.Float, "value", wasm.f64$eq);

funcs.build("eq",
  [wasm.i32, wasm.i32], [wasm.i32], {
    comp: [wrap_result_i32_to_bool]
  },
  function (a, b) {
    return [
      wasm.local$get, ...a,
      wasm.local$get, ...b,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.i32$const, 1,
      wasm.else,
        wasm.local$get, ...a,
        wasm.local$get, ...b,
        wasm.call, ...equiv.func_idx_leb128,
      wasm.end
    ];
  }
);

/*-------*\
|         |
| HashMap |
|         |
\*-------*/

const empty_partial_node = comp.PartialNode(empty_refs_array, 0),
// todo: start with full_node, implement node methods for nil
      empty_hash_map = comp.HashMap(empty_partial_node, 0);

const map_node_assoc = pre_new_method(null, 6, 0, 0, wasm.i32, {}),
      map_node_lookup = pre_new_method(null, 4, 0, 0, wasm.i32, {});

impl_free(types.PartialNode, function (func) {
  const node = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...node,
    wasm.call, ...types.PartialNode.fields.arr.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

impl_free(types.FullNode, function (func) {
  const node = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...node,
    wasm.call, ...types.FullNode.fields.arr.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

impl_free(types.HashCollisionNode, function (func) {
  const node = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...node,
    wasm.call, ...types.HashCollisionNode.fields.arr.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

impl_free(types.LeafNode, function (func) {
  const node = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...node,
    wasm.call, ...types.LeafNode.fields.key.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...node,
    wasm.call, ...types.LeafNode.fields.val.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

impl_free(types.HashMap, function (func) {
  const map = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...map,
    wasm.call, ...types.HashMap.fields.count.leb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...map,
      wasm.call, ...types.HashMap.fields.root.leb128,
      wasm.call, ...free.func_idx_leb128,
      wasm.i32$const, 1,
    wasm.else,
      wasm.i32$const, 0,
    wasm.end
  );
});

// shifts hash right by a multiple of 5 corresponding
// to the level of the node (0 = top level, 5, 10, etc)
// then applies mask of 31 (0b11111) to extract the
// last five bits. good explanation here:
// http://blog.higher-order.net/2009/09/08/understanding-clojures-persistenthashmap-deftwice
// shift: 30 25     20     15     10     5      0
// hash:  00 00000  00000  00000  00000  00000  00000
// mask:  00 00000  00000  00000  00000  00000  11111
// in principle, the result is the element's index in a
// node array, and that's true in ArrayNode, but
// BitmapIndexedNode uses the next two functions to
// pack elements in more tightly & conserve memory
funcs.build("mask",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (hash, shift) {
    return [
      wasm.local$get, ...hash,
      wasm.local$get, ...shift,
      wasm.i32$shr_u,
      wasm.i32$const, 31,
      wasm.i32$and
    ];
  }
);

// convert the output of mask to a power of 2
// e.g. if output of mask is 0b10101 (21)
// then 1 << 21 == 0b00000000001000000000000000000000.
// this is added to a BitmapIndexedNode's bitmap
// to show that there is an element at index 21.
funcs.build("bitpos",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (hash, shift) {
    return [
      wasm.i32$const, 1,
      wasm.local$get, ...hash,
      wasm.local$get, ...shift,
      wasm.call, ...funcs.uleb128.mask,
      wasm.i32$shl
    ];
  }
);

// using the BitmapIndexedNode's bitmap and the output of bitpos,
// we determine the actual index of the element in the packed
// array. Subtracting 1 from bitpos produces a mask for all bits
// to the right of bitpos. For instance, 
// 0b00000000001000000000000000000000 - 1 =
// 0b00000000000111111111111111111111
// next we apply this mask to the bitmap to extract all bits to
// the right of bitpos, then count the 1's. The result is the
// element's index in the array. Thus the array has no unused
// indexes
funcs.build("bitmap_indexed_node_index",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (bitmap, bit) {
    return [
      wasm.local$get, ...bitmap,
      wasm.local$get, ...bit,
      wasm.i32$const, 1,
      wasm.i32$sub,
      wasm.i32$and,
      wasm.i32$popcnt
    ];
  }
);

const no_entry = comp.alloc(4);

map_node_assoc.implement(types.PartialNode, function (
  node, shift, hsh, key, val, added_leaf
) {
  const bit = this.local(wasm.i32),
        bitmap = this.local(wasm.i32),
        idx = this.local(wasm.i32),
        arr = this.local(wasm.i32),
        len = this.local(wasm.i32),
        child_node = this.local(wasm.i32);
  return [
    wasm.local$get, ...hsh,
    wasm.local$get, ...shift,
    wasm.call, ...funcs.uleb128.bitpos,
    wasm.local$tee, ...bit,
    wasm.local$get, ...node,
    wasm.call, ...types.PartialNode.fields.bitmap.leb128,
    wasm.local$tee, ...bitmap,
    wasm.i32$and,
    wasm.local$get, ...bitmap,
    wasm.local$get, ...bit,
    wasm.call, ...funcs.uleb128.bitmap_indexed_node_index,
    wasm.local$set, ...idx,
    wasm.local$get, ...node,
    wasm.call, ...types.PartialNode.fields.arr.leb128,
    wasm.local$set, ...arr,
    wasm.if, wasm.i32,
      wasm.local$get, ...arr,
      wasm.local$get, ...idx,
      wasm.call, ...funcs.uleb128.refs_array_get,
      wasm.local$tee, ...child_node,
      wasm.local$get, ...child_node,
      wasm.local$get, ...shift,
      wasm.i32$const, 5,
      wasm.i32$add,
      wasm.local$get, ...hsh,
      wasm.local$get, ...key,
      wasm.local$get, ...val,
      wasm.local$get, ...added_leaf,
      wasm.call, ...map_node_assoc.func_idx_leb128,
      wasm.local$tee, ...child_node,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...node,
      wasm.else,
        wasm.local$get, ...arr,
        wasm.call, ...funcs.uleb128.refs_array_clone,
        wasm.local$get, ...idx,
        wasm.local$get, ...child_node,
        wasm.call, ...funcs.uleb128.refs_array_set_no_inc,
        wasm.local$get, ...bitmap,
        wasm.call, ...types.PartialNode.constr.leb128,
      wasm.end,
    wasm.else,
      wasm.local$get, ...added_leaf,
      wasm.i32$const, 1,
      wasm.i32$store, 2, 0,
      wasm.local$get, ...arr,
      wasm.local$get, ...idx,
      wasm.local$get, ...arr,
      wasm.i32$const, 0,
      wasm.local$get, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$tee, ...len,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.call, ...funcs.uleb128.refs_array_by_length,
      wasm.i32$const, 0,
      wasm.local$get, ...idx,
      wasm.call, ...funcs.uleb128.refs_array_copy,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$get, ...len,
      wasm.local$get, ...idx,
      wasm.i32$sub,
      wasm.call, ...funcs.uleb128.refs_array_copy,
      wasm.local$get, ...idx,
      wasm.local$get, ...key,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.call, ...types.LeafNode.constr.leb128,
      wasm.call, ...funcs.uleb128.refs_array_set_no_inc,
      wasm.local$set, ...arr,
      wasm.local$get, ...len,
      wasm.i32$const, ...sleb128i32(31),
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...arr,
        wasm.call, ...types.FullNode.constr.leb128,
      wasm.else,
        wasm.local$get, ...arr,
        wasm.local$get, ...bitmap,
        wasm.local$get, ...bit,
        wasm.i32$or,
        wasm.call, ...types.PartialNode.constr.leb128,
      wasm.end,
    wasm.end
  ];
});

map_node_assoc.implement(types.FullNode, function (
  node, shift, hsh, key, val, added_leaf
) {
  const arr = this.local(wasm.i32),
        idx = this.local(wasm.i32),
        child_node = this.local(wasm.i32);
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.FullNode.fields.arr.leb128,
    wasm.local$tee, ...arr,
    wasm.local$get, ...hsh,
    wasm.local$get, ...shift,
    wasm.call, ...funcs.uleb128.mask,
    wasm.local$tee, ...idx,
    wasm.call, ...funcs.uleb128.refs_array_get,
    wasm.local$tee, ...child_node,
    wasm.local$get, ...child_node,
    wasm.local$get, ...shift,
    wasm.i32$const, 5,
    wasm.i32$add,
    wasm.local$get, ...hsh,
    wasm.local$get, ...key,
    wasm.local$get, ...val,
    wasm.local$get, ...added_leaf,
    wasm.call, ...map_node_assoc.func_idx_leb128,
    wasm.local$tee, ...child_node,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
    wasm.else,
      wasm.local$get, ...arr,
      wasm.call, ...funcs.uleb128.refs_array_clone,
      wasm.local$get, ...idx,
      wasm.local$get, ...child_node,
      wasm.call, ...funcs.uleb128.refs_array_set_no_inc,
      wasm.call, ...types.FullNode.constr.leb128,
    wasm.end
  ];
});

map_node_assoc.implement(types.LeafNode, function (
  node, shift, hsh, key, val, added_leaf
) {
  const key2 = this.local(wasm.i32),
        val2 = this.local(wasm.i32),
        hsh2 = this.local(wasm.i32);
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.LeafNode.fields.key.leb128,
    wasm.local$tee, ...key2,
    wasm.local$get, ...key,
    wasm.call, ...funcs.uleb128.eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
      wasm.call, ...types.LeafNode.fields.val.leb128,
      wasm.local$get, ...val,
      wasm.call, ...funcs.uleb128.eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...node,
      wasm.else,
        wasm.local$get, ...key,
        wasm.call, ...inc_refs.func_idx_leb128,
        wasm.local$get, ...val,
        wasm.call, ...inc_refs.func_idx_leb128,
        wasm.call, ...types.LeafNode.constr.leb128,
      wasm.end,
    wasm.else,
      wasm.local$get, ...added_leaf,
      wasm.i32$const, 1,
      wasm.i32$store, 2, 0,
      wasm.local$get, ...key2,
      wasm.call, ...hash.func_idx_leb128,
      wasm.local$tee, ...hsh2,
      wasm.local$get, ...hsh,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.i32$const, 2,
        wasm.call, ...funcs.uleb128.refs_array_by_length,
        wasm.i32$const, 0,
        wasm.local$get, ...node,
        wasm.call, ...funcs.uleb128.refs_array_set,
        wasm.i32$const, 1,
        wasm.local$get, ...key,
        wasm.call, ...inc_refs.func_idx_leb128,
        wasm.local$get, ...val,
        wasm.call, ...inc_refs.func_idx_leb128,
        wasm.call, ...types.LeafNode.constr.leb128,
        wasm.call, ...funcs.uleb128.refs_array_set_no_inc,
        wasm.local$get, ...hsh,
        wasm.call, ...types.HashCollisionNode.constr.leb128,
      wasm.else,
        wasm.i32$const, ...sleb128i32(empty_partial_node),
        wasm.local$get, ...shift,
        wasm.local$get, ...hsh2,
        wasm.local$get, ...key2,
        wasm.local$get, ...node,
        wasm.call, ...types.LeafNode.fields.val.leb128,
        wasm.local$get, ...added_leaf,
        wasm.call, ...map_node_assoc.func_idx_leb128,
        wasm.local$tee, ...node,
        wasm.local$get, ...shift,
        wasm.local$get, ...hsh,
        wasm.local$get, ...key,
        wasm.local$get, ...val,
        wasm.local$get, ...added_leaf,
        wasm.call, ...map_node_assoc.func_idx_leb128,
        wasm.local$get, ...node,
        wasm.call, ...free.func_idx_leb128,
      wasm.end,
    wasm.end
  ];
});

funcs.build("hash_collision_node_find_entry",
  [wasm.i32, wasm.i32], [wasm.i32, wasm.i32], {},
  function (node, key) {
    const idx = this.local(wasm.i32),
          arr = this.local(wasm.i32),
          len = this.local(wasm.i32),
          leaf = this.local(wasm.i32);
    return [
      wasm.local$get, ...node,
      wasm.call, ...types.HashCollisionNode.fields.arr.leb128,
      wasm.local$tee, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$set, ...len,
      wasm.loop, wasm.i32,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.refs_array_get,
        wasm.local$tee, ...leaf,
        wasm.call, ...types.LeafNode.fields.key.leb128,
        wasm.local$get, ...key,
        wasm.call, ...funcs.uleb128.eq,
        wasm.if, wasm.i32,
          wasm.local$get, ...leaf,
        wasm.else,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$tee, ...idx,
          wasm.local$get, ...len,
          wasm.i32$lt_u,
          wasm.if, wasm.i32,
            wasm.br, 2,
          wasm.else,
            wasm.i32$const, 0,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.local$get, ...idx
    ];
  }
);

map_node_assoc.implement(types.HashCollisionNode, function (
  node, shift, hsh, key, val, added_leaf
) {
  const hsh2 = this.local(wasm.i32),
        arr = this.local(wasm.i32),
        idx = this.local(wasm.i32),
        len = this.local(wasm.i32),
        leaf = this.local(wasm.i32);
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.HashCollisionNode.fields.collision_hash.leb128,
    wasm.local$tee, ...hsh2,
    wasm.local$get, ...hsh,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
      wasm.call, ...types.HashCollisionNode.fields.arr.leb128,
      wasm.local$tee, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$set, ...len,
      wasm.local$get, ...node,
      wasm.local$get, ...key,
      wasm.call, ...funcs.uleb128.hash_collision_node_find_entry,
      wasm.local$set, ...idx,
      wasm.local$tee, ...leaf,
      wasm.if, wasm.i32,
        wasm.local$get, ...leaf,
        wasm.call, ...types.LeafNode.fields.val.leb128,
        wasm.local$get, ...val,
        wasm.call, ...funcs.uleb128.eq,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end,
      wasm.if, wasm.i32,
        wasm.local$get, ...node,
      wasm.else,
        wasm.local$get, ...leaf,
        wasm.if, wasm.i32,
          wasm.local$get, ...added_leaf,
          wasm.i32$const, 1,
          wasm.i32$store, 2, 0,
          wasm.local$get, ...arr,
          wasm.call, ...funcs.uleb128.refs_array_clone,
        wasm.else,
          wasm.local$get, ...arr,
          wasm.local$get, ...len,
          wasm.call, ...funcs.uleb128.refs_array_fit_and_copy,
        wasm.end,
        wasm.local$get, ...leaf,
        wasm.if, wasm.i32,
          wasm.local$get, ...idx,
        wasm.else,
          wasm.local$get, ...len,
        wasm.end,
        wasm.local$get, ...key,
        wasm.call, ...inc_refs.func_idx_leb128,
        wasm.local$get, ...val,
        wasm.call, ...inc_refs.func_idx_leb128,
        wasm.call, ...types.LeafNode.constr.leb128,
        wasm.call, ...funcs.uleb128.refs_array_set_no_inc,
        wasm.local$get, ...hsh,
        wasm.call, ...types.HashCollisionNode.constr.leb128,
      wasm.end,
    wasm.else,
      wasm.local$get, ...hsh2,
      wasm.local$get, ...shift,
      wasm.i32$const, 1,
      wasm.call, ...funcs.uleb128.refs_array_by_length,
      wasm.i32$const, 0,
      wasm.local$get, ...node,
      wasm.call, ...funcs.uleb128.refs_array_set,
      wasm.call, ...funcs.uleb128.bitpos,
      wasm.call, ...types.PartialNode.constr.leb128,
      wasm.local$tee, ...node,
      wasm.local$get, ...shift,
      wasm.local$get, ...hsh,
      wasm.local$get, ...key,
      wasm.local$get, ...val,
      wasm.local$get, ...added_leaf,
      wasm.call, ...map_node_assoc.func_idx_leb128,
      wasm.local$get, ...node,
      wasm.call, ...free.func_idx_leb128,
    wasm.end
  ];
});

map_node_lookup.implement(types.PartialNode, function (
  node, shift, hsh, key
) {
  const bitmap = this.local(wasm.i32),
        bit = this.local(wasm.i32);
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.PartialNode.fields.bitmap.leb128,
    wasm.local$tee, ...bitmap,
    wasm.local$get, ...hsh,
    wasm.local$get, ...shift,
    wasm.call, ...funcs.uleb128.bitpos,
    wasm.local$tee, ...bit,
    wasm.i32$and,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
      wasm.call, ...types.PartialNode.fields.arr.leb128,
      wasm.local$get, ...bitmap,
      wasm.local$get, ...bit,
      wasm.call, ...funcs.uleb128.bitmap_indexed_node_index,
      wasm.call, ...funcs.uleb128.refs_array_get,
      wasm.local$get, ...shift,
      wasm.i32$const, 5,
      wasm.i32$add,
      wasm.local$get, ...hsh,
      wasm.local$get, ...key,
      wasm.call, ...map_node_lookup.func_idx_leb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(no_entry),
    wasm.end
  ];
});

map_node_lookup.implement(types.FullNode, function (
  node, shift, hsh, key
) {
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.FullNode.fields.arr.leb128,
    wasm.local$get, ...hsh,
    wasm.local$get, ...shift,
    wasm.call, ...funcs.uleb128.mask,
    wasm.call, ...funcs.uleb128.refs_array_get,
    wasm.local$get, ...shift,
    wasm.i32$const, 5,
    wasm.i32$add,
    wasm.local$get, ...hsh,
    wasm.local$get, ...key,
    wasm.call, ...map_node_lookup.func_idx_leb128
  ];
});

map_node_lookup.implement(types.LeafNode, function (
  node, shift, hsh, key
) {
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.LeafNode.fields.key.leb128,
    wasm.local$get, ...key,
    wasm.call, ...funcs.uleb128.eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
      wasm.call, ...types.LeafNode.fields.val.leb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(no_entry),
    wasm.end
  ];
});

map_node_lookup.implement(types.HashCollisionNode, function (
  node, shift, hsh, key
) {
  const leaf = this.local(wasm.i32);
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.HashCollisionNode.fields.collision_hash.leb128,
    wasm.local$get, ...hsh,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
      wasm.local$get, ...key,
      wasm.call, ...funcs.uleb128.hash_collision_node_find_entry,
      wasm.drop,
      wasm.local$tee, ...leaf,
      wasm.if, wasm.i32,
        wasm.local$get, ...leaf,
        wasm.call, ...types.LeafNode.fields.val.leb128,
      wasm.else,
        wasm.i32$const, ...sleb128i32(no_entry),
      wasm.end,
    wasm.else,
      wasm.i32$const, ...sleb128i32(no_entry),
    wasm.end
  ];
});

assoc.implement(types.HashMap, function (map, key, val) {
  const added_leaf = this.local(wasm.i32),
        root = this.local(wasm.i32),
        new_root = this.local(wasm.i32);
  return [
    wasm.local$get, ...map,
    wasm.call, ...types.HashMap.fields.root.leb128,
    wasm.local$tee, ...root,
    wasm.i32$const, 0,
    wasm.local$get, ...key,
    wasm.call, ...hash.func_idx_leb128,
    wasm.local$get, ...key,
    wasm.local$get, ...val,
    wasm.i32$const, 4,
    wasm.call, ...funcs.uleb128.alloc,
    wasm.local$tee, ...added_leaf,
    wasm.call, ...map_node_assoc.func_idx_leb128,
    wasm.local$tee, ...new_root,
    wasm.local$get, ...root,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...map,
    wasm.else,
      wasm.local$get, ...new_root,
      wasm.local$get, ...map,
      wasm.call, ...types.HashMap.fields.count.leb128,
      wasm.local$get, ...added_leaf,
      wasm.i32$load, 2, 0,
      wasm.i32$add,
      wasm.call, ...types.HashMap.constr.leb128,
    wasm.end,
    wasm.local$get, ...added_leaf,
    wasm.i32$const, 4,
    wasm.call, ...funcs.uleb128.free_mem,
  ];
});

get.implement(types.HashMap, function (map, key, not_found) {
  const result = this.local(wasm.i32);
  return [
    wasm.local$get, ...map,
    wasm.call, ...types.HashMap.fields.root.leb128,
    wasm.i32$const, 0,
    wasm.local$get, ...key,
    wasm.call, ...hash.func_idx_leb128,
    wasm.local$get, ...key,
    wasm.call, ...map_node_lookup.func_idx_leb128,
    wasm.local$tee, ...result,
    wasm.i32$const, ...sleb128i32(no_entry),
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...not_found,
    wasm.else,
      wasm.local$get, ...result,
    wasm.end
  ];
});

count.implement(types.HashMap, function (map) {
  return [
    wasm.local$get, ...map,
    wasm.call, ...types.HashMap.fields.count.leb128
  ];
});

/*---*\
|     |
| Seq |
|     |
\*---*/

const empty_seq = comp.Seq(nil);

count.implement(types.Nil, function () {
  return [wasm.i32$const, 0];
});

nth.implement(types.Nil, function () {
  return [wasm.i32$const, nil];
});

first.implement(types.Nil, function () {
  return [wasm.i32$const, nil];
});

rest.implement(types.Nil, function () {
  return [wasm.i32$const, ...sleb128i32(empty_seq)];
});

// todo: will this work for user-defined seqs?
impl_free(types.Seq, function (func) {
  const seq = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...seq,
    wasm.call, ...count.func_idx_leb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...seq,
      wasm.call, ...types.Seq.fields.root.leb128,
      wasm.call, ...free.func_idx_leb128,
      wasm.i32$const, 1,
    wasm.else,
      wasm.i32$const, 0,
    wasm.end
  );
});

function impl_seq_pass_through (typ, mtd, reconstitute) {
  mtd.implement(typ, function () {
    const args = [];
    for (let i = 0; i < mtd.num_args; i++) {
      if (i) args.push(wasm.local$get, ...sleb128i32(i));
    }
    const out = this.local(wasm.i32);
    return [
      wasm.local$get, 0,
      wasm.call, ...typ.fields.root.leb128,
      ...args,
      wasm.call, ...mtd.func_idx_leb128,
      ...(
        reconstitute ?
        [wasm.call, ...typ.constr.leb128] :
        []
      )
    ];
  });
}

impl_seq_pass_through(types.Seq, count);
impl_seq_pass_through(types.Seq, first);
impl_seq_pass_through(types.Seq, nth);
impl_seq_pass_through(types.Seq, rest, true);

to_seq.implement(types.Seq, function (seq) {
  return [wasm.local$get, ...seq];
});

/*-------*\
|         |
| ConsSeq |
|         |
\*-------*/

impl_free(types.ConsSeq, function (func) {
  const seq = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...seq,
    wasm.call, ...types.ConsSeq.fields.first.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.ConsSeq.fields.rest.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

first.implement(types.ConsSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConsSeq.fields.first.leb128
  ];
});

rest.implement(types.ConsSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConsSeq.fields.rest.leb128
  ];
});

count.implement(types.ConsSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConsSeq.fields.rest.leb128,
    wasm.call, ...count.func_idx_leb128,
    wasm.i32$const, 1,
    wasm.i32$add
  ];
});

/*-------*\
|         |
| LazySeq |
|         |
\*-------*/

impl_free(types.LazySeq, function (func) {
  const seq = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...seq,
    wasm.call, ...types.LazySeq.fields.generator.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.LazySeq.fields.seq.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1,
  );
});

funcs.build("gen_seq",
  [wasm.i32], [], {},
  function (seq) {
    const gen = this.local(wasm.i32);
    return [
      wasm.local$get, ...seq,
      wasm.call, ...types.LazySeq.fields.seq_set.leb128,
      wasm.i32$eqz,
      wasm.if, wasm.void,
        wasm.local$get, ...seq,
        wasm.i32$const, ...sleb128i32(types.LazySeq.fields.seq.offset),
        wasm.i32$add,
        wasm.local$get, ...seq,
        wasm.call, ...types.LazySeq.fields.generator.leb128,
        wasm.local$tee, ...gen,
        wasm.call, ...types.VariadicFunction.fields.args.leb128,
        wasm.local$get, ...gen,
        wasm.call, ...types.VariadicFunction.fields.func.leb128,
        wasm.call, ...types.Function.fields.tbl_idx.leb128,
        wasm.call_indirect,
        ...sleb128i32(get_type_idx(1, 0, 0, wasm.i32)), 0,
        wasm.atomic$prefix,
        wasm.i32$atomic$store, 2, 0,
        wasm.local$get, ...seq,
        wasm.i32$const, ...sleb128i32(types.LazySeq.fields.seq_set.offset),
        wasm.i32$add,
        wasm.i32$const, 1,
        wasm.atomic$prefix,
        wasm.i32$atomic$store, 2, 0,
      wasm.end,
    ];
  }
);

first.implement(types.LazySeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...funcs.uleb128.gen_seq,
    wasm.local$get, ...seq,
    wasm.call, ...types.LazySeq.fields.seq.leb128,
    wasm.call, ...first.func_idx_leb128,
  ];
});

rest.implement(types.LazySeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...funcs.uleb128.gen_seq,
    wasm.local$get, ...seq,
    wasm.call, ...types.LazySeq.fields.seq.leb128,
    wasm.call, ...rest.func_idx_leb128,
  ];
});

count.implement(types.LazySeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...funcs.uleb128.gen_seq,
    wasm.local$get, ...seq,
    wasm.call, ...types.LazySeq.fields.seq.leb128,
    wasm.call, ...count.func_idx_leb128
  ];
});

funcs.build("lazy-seq",
  [wasm.i32], [wasm.i32], { comp: true },
  function (gen) {
    return [
      wasm.local$get, ...gen,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.i32$const, nil,
      wasm.i32$const, 0,
      wasm.call, ...types.LazySeq.constr.leb128,
      wasm.call, ...types.Seq.constr.leb128
    ];
  }
);

/*---------*\
|           |
| ConcatSeq |
|           |
\*---------*/

impl_free(types.ConcatSeq, function (func) {
  const seq = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.left.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.right.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

count.implement(types.ConcatSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.left.leb128,
    wasm.call, ...count.func_idx_leb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.right.leb128,
    wasm.call, ...count.func_idx_leb128,
    wasm.i32$add
  ];
});

first.implement(types.ConcatSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.left.leb128,
    wasm.call, ...first.func_idx_leb128
  ];
});

rest.implement(types.ConcatSeq, function (seq) {
  const left = this.local(wasm.i32),
        right = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.right.leb128,
    wasm.local$set, ...right,
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.left.leb128,
    wasm.call, ...rest.func_idx_leb128,
    wasm.local$tee, ...left,
    wasm.call, ...count.func_idx_leb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...left,
      wasm.local$get, ...right,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.call, ...types.ConcatSeq.constr.leb128,
      wasm.call, ...types.Seq.constr.leb128,
    wasm.else,
      wasm.local$get, ...right,
      wasm.call, ...rest.func_idx_leb128,
    wasm.end
  ];
});

funcs.build("concat",
  [wasm.i32, wasm.i32], [wasm.i32], { comp: true },
  function (left, right) {
    return [
      wasm.local$get, ...left,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.local$get, ...right,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.call, ...types.ConcatSeq.constr.leb128,
      wasm.call, ...types.Seq.constr.leb128,
    ];
  }
);

/*---------*\
|           |
| VectorSeq |
|           |
\*---------*/

count.implement(types.VectorSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.vec.leb128,
    wasm.call, ...count.func_idx_leb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.vec_off.leb128,
    wasm.i32$sub,
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.arr_off.leb128,
    wasm.i32$sub
  ];
});

nth.implement(types.VectorSeq, function (seq, n, not_found) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.vec.leb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.vec_off.leb128,
    wasm.local$get, ...n,
    wasm.i32$add,
    wasm.local$get, ...not_found,
    wasm.call, ...nth.func_idx_leb128
  ];
});

first.implement(types.VectorSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.arr.leb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.arr_off.leb128,
    wasm.call, ...funcs.uleb128.refs_array_get
  ];
});

rest.implement(types.VectorSeq, function (seq) {
  const len = this.local(wasm.i32),
        arr = this.local(wasm.i32),
        arr_off = this.local(wasm.i32),
        vec = this.local(wasm.i32),
        vec_off = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...count.func_idx_leb128,
    wasm.i32$const, 1,
    wasm.i32$gt_u,
    wasm.if, wasm.i32,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.vec.leb128,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.local$set, ...vec,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.vec_off.leb128,
      wasm.local$set, ...vec_off,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.arr_off.leb128,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$tee, ...arr_off,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.arr.leb128,
      wasm.local$tee, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.leb128,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$tee, ...len,
      wasm.i32$lt_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...arr,
        wasm.local$get, ...arr_off,
        wasm.local$get, ...vec,
        wasm.local$get, ...vec_off,
        wasm.call, ...types.VectorSeq.constr.leb128,
      wasm.else,
        wasm.local$get, ...vec,
        wasm.local$get, ...vec_off,
        wasm.local$get, ...len,
        wasm.i32$add,
        wasm.local$tee, ...vec_off,
        wasm.call, ...funcs.uleb128.unchecked_array_for,
        wasm.i32$const, 0,
        wasm.local$get, ...vec,
        wasm.local$get, ...vec_off,
        wasm.call, ...types.VectorSeq.constr.leb128,
      wasm.end,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

impl_free(types.VectorSeq, function (func) {
  const seq = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...seq,
    wasm.call, ...count.func_idx_leb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.vec.leb128,
      wasm.call, ...free.func_idx_leb128,
      wasm.i32$const, 1,
    wasm.else,
      wasm.i32$const, 0,
    wasm.end
  );
});

to_seq.implement(types.Vector, function (vec) {
  const cnt = this.local(wasm.i32),
        shift = this.local(wasm.i32),
        arr = this.local(wasm.i32);
  return [
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.count.leb128,
    wasm.local$tee, ...cnt,
    wasm.if, wasm.i32,
      wasm.local$get, ...cnt,
      wasm.i32$const, 32,
      wasm.i32$le_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.tail.leb128,
      wasm.else,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.shift.leb128,
        wasm.local$set, ...shift,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.root.leb128,
        wasm.local$set, ...arr,
        wasm.loop, wasm.i32,
          wasm.local$get, ...shift,
          wasm.if, wasm.i32,
            wasm.local$get, ...arr,
            wasm.i32$const, 0,
            wasm.call, ...funcs.uleb128.refs_array_get,
            wasm.local$set, ...arr,
            wasm.local$get, ...shift,
            wasm.i32$const, 5,
            wasm.i32$sub,
            wasm.local$set, ...shift,
            wasm.br, 1,
          wasm.else,
            wasm.local$get, ...arr,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.i32$const, 0,
      wasm.local$get, ...vec,
      wasm.i32$const, 0,
      wasm.call, ...types.VectorSeq.constr.leb128,
      wasm.call, ...types.Seq.constr.leb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

funcs.build("seq_append",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (seq, val) {
    const root = this.local(wasm.i32);
    return [
      wasm.local$get, ...seq,
      wasm.call, ...types.Seq.fields.root.leb128,
      wasm.local$tee, ...root,
      wasm.if, wasm.i32,
        wasm.local$get, ...root,
        wasm.call, ...types.VectorSeq.fields.vec.leb128,
      wasm.else,
        wasm.i32$const, ...sleb128i32(empty_vector),
      wasm.end,
      wasm.local$get, ...val,
      wasm.call, ...conj.func_idx_leb128,
      wasm.call, ...to_seq.func_idx_leb128
    ];
  }
);

funcs.build("vector_seq_from_array",
  [wasm.i32], [wasm.i32], {},
  function (arr) {
    return [
      wasm.local$get, ...arr,
      wasm.call, ...funcs.uleb128.vector_from_array,
      wasm.call, ...to_seq.func_idx_leb128
    ];
  }
);

/*----------*\
|            |
| HashMapSeq |
|            |
\*----------*/

impl_free(types.HashMapSeq, function (func) {
  const seq = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapSeq.fields.map.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapSeq.fields.root.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

impl_free(types.HashMapNodeSeq, function (func) {
  const seq = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapNodeSeq.fields.curr_seq.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapNodeSeq.fields.nodes.leb128,
    wasm.call, ...free.func_idx_leb128,
    wasm.i32$const, 1
  );
});

count.implement(types.HashMapSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapSeq.fields.map.leb128,
    wasm.call, ...count.func_idx_leb128
  ];
});

impl_seq_pass_through(types.HashMapSeq, first);
impl_seq_pass_through(types.HashMapSeq, nth);

rest.implement(types.HashMapSeq, function (seq) {
  const out = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapSeq.fields.root.leb128,
    wasm.call, ...rest.func_idx_leb128,
    wasm.local$tee, ...out,
    wasm.if, wasm.i32,
      wasm.local$get, ...seq,
      wasm.call, ...types.HashMapSeq.fields.map.leb128,
      wasm.local$get, ...out,
      wasm.call, ...types.HashMapSeq.constr.leb128,
      wasm.call, ...types.Seq.constr.leb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

funcs.build("hash_map_node_seq",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, off) {
    const node = this.local(wasm.i32);
    return [
      wasm.local$get, ...arr,
      wasm.local$get, ...off,
      wasm.call, ...funcs.uleb128.refs_array_get,
      wasm.local$tee, ...node,
      wasm.i32$load, 2, 0,
      wasm.i32$const, ...sleb128i32(types.LeafNode.type_num),
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.i32$const, nil,
      wasm.else,
        wasm.local$get, ...node,
        wasm.i32$const, 0,
        wasm.call, ...this.func_idx_leb128,
      wasm.end,
      wasm.local$get, ...arr,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.local$get, ...off,
      wasm.call, ...types.HashMapNodeSeq.constr.leb128
    ];
  }
);

first.implement(types.HashMapNodeSeq, function (seq) {
  const curr_seq = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapNodeSeq.fields.curr_seq.leb128,
    wasm.local$tee, ...curr_seq,
    wasm.if, wasm.i32,
      wasm.local$get, ...curr_seq,
      wasm.call, ...first.func_idx_leb128,
    wasm.else,
      wasm.local$get, ...seq,
      wasm.call, ...types.HashMapNodeSeq.fields.nodes.leb128,
      wasm.local$get, ...seq,
      wasm.call, ...types.HashMapNodeSeq.fields.offset.leb128,
      wasm.call, ...funcs.uleb128.refs_array_get,
    wasm.end
  ];
});

rest.implement(types.HashMapNodeSeq, function (seq) {
  const off = this.local(wasm.i32),
        nodes = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapNodeSeq.fields.nodes.leb128,
    wasm.local$tee, ...nodes,
    wasm.call, ...types.RefsArray.fields.arr.leb128,
    wasm.call, ...types.Array.fields.length.leb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapNodeSeq.fields.offset.leb128,
    wasm.i32$const, 1,
    wasm.i32$add,
    wasm.local$tee, ...off,
    wasm.i32$gt_u,
    wasm.if, wasm.i32,
      wasm.local$get, ...nodes,
      wasm.local$get, ...off,
      wasm.call, ...funcs.uleb128.hash_map_node_seq,
    wasm.else,
      wasm.i32$const, nil,
    wasm.end
  ];
});

to_seq.implement(types.HashMap, function (map) {
  const root = this.local(wasm.i32);
  return [
    wasm.local$get, ...map,
    wasm.call, ...types.HashMap.fields.count.leb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...map,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.local$get, ...map,
      wasm.call, ...types.HashMap.fields.root.leb128,
      wasm.call, ...types.PartialNode.fields.arr.leb128,
      wasm.i32$const, 0,
      wasm.call, ...funcs.uleb128.hash_map_node_seq,
      wasm.call, ...types.HashMapSeq.constr.leb128,
      wasm.call, ...types.Seq.constr.leb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

/*------*\
|        |
| symbol |
|        |
\*------*/

const symkw = function (which) {
  const store = new_atom(empty_hash_map);
  let type = types.Symbol;
  if (which === "keyword") type = types.Keyword;
  return funcs.build(which,
    [wasm.i32, wasm.i32],
    [wasm.i32], { export: true, comp: true },
    function (namespace, name) {
      const syms = this.local(wasm.i32),
            with_ns = this.local(wasm.i32),
            out = this.local(wasm.i32);
      return [
        wasm.i32$const, ...sleb128i32(store),
        wasm.call, ...funcs.uleb128.atom_swap_lock,
        wasm.local$tee, ...syms,
        wasm.local$get, ...namespace,
        wasm.i32$const, 0,
        wasm.call, ...get.func_idx_leb128,
        wasm.local$tee, ...with_ns,
        wasm.if, wasm.i32,
          wasm.local$get, ...with_ns,
          wasm.local$get, ...name,
          wasm.i32$const, 0,
          wasm.call, ...get.func_idx_leb128,
          wasm.local$tee, ...out,
        wasm.else,
          wasm.i32$const, ...sleb128i32(empty_hash_map),
          wasm.local$set, ...with_ns,
          wasm.i32$const, 0,
        wasm.end,
        wasm.if, wasm.void,
          wasm.i32$const, ...sleb128i32(store),
          wasm.call, ...funcs.uleb128.atom_swap_unlock,
          wasm.drop,
        wasm.else,
          wasm.local$get, ...namespace,
          wasm.call, ...inc_refs.func_idx_leb128,
          wasm.local$get, ...name,
          wasm.call, ...inc_refs.func_idx_leb128,
          wasm.call, ...type.constr.leb128,
          wasm.local$set, ...out,
          wasm.i32$const, ...sleb128i32(store),
          wasm.local$get, ...syms,
          wasm.local$get, ...namespace,
          wasm.local$get, ...with_ns,
          wasm.local$get, ...name,
          wasm.local$get, ...out,
          wasm.call, ...assoc.func_idx_leb128,
          wasm.call, ...assoc.func_idx_leb128,
          wasm.call, ...funcs.uleb128.atom_swap_set,
          wasm.drop,
          wasm.local$get, ...with_ns,
          wasm.call, ...free.func_idx_leb128,
          wasm.local$get, ...syms,
          wasm.call, ...free.func_idx_leb128,
        wasm.end,
        wasm.local$get, ...out,
      ];
    }
  );
}

symkw("keyword");
symkw("symbol");

function make_symkw (which) {
  return function (ns, nm) {
    if (arguments.length === 1) {
      nm = ns;
      ns = 0;
    }
    if (typeof ns === "string") ns = cached_string(ns);
    if (typeof nm === "string") nm = cached_string(nm);
    return comp[which](ns, nm);
  }
}

const make_symbol = make_symkw("symbol");
const make_keyword = make_symkw("keyword");

compile();

/*--------*\
|          |
| bindings |
|          |
\*--------*/

const global_env = new_atom(empty_hash_map);

funcs.build("store_binding",
  [wasm.i32, wasm.i32, wasm.i32], [], { export: true },
  function (sym, val, env) {
    const map = this.local(wasm.i32);
    return [
      wasm.local$get, ...env,
      wasm.local$get, ...env,
      wasm.call, ...funcs.uleb128.atom_swap_lock,
      wasm.local$tee, ...map,
      wasm.local$get, ...sym,
      wasm.local$get, ...val,
      wasm.call, ...assoc.func_idx_leb128,
      wasm.call, ...funcs.uleb128.atom_swap_set,
      wasm.drop,
      wasm.local$get, ...map,
      wasm.call, ...free.func_idx_leb128
    ];
  }
);

funcs.build("make_comp_func",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], { export: true },
  function (
    func_num,
    i32_args,
    i64_args,
    f64_args,
    result
  ) {
    return [
      wasm.local$get, ...func_num,
      wasm.local$get, ...func_num,
      wasm.call, ...add_to_func_table.func_idx_leb128,
      wasm.local$get, ...i32_args,
      wasm.local$get, ...i64_args,
      wasm.local$get, ...f64_args,
      wasm.local$get, ...result,
      wasm.call, ...get_type_idx.func_idx_leb128,
      wasm.local$get, ...result,
      wasm.local$get, ...i32_args,
      wasm.local$get, ...i64_args,
      wasm.local$get, ...f64_args,
      wasm.call, ...types.Function.constr.leb128
    ];
  }
);

funcs.build("store_comp_func",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [], { export: true },
  function (
    name,
    i32_args,
    i64_args,
    f64_args,
    result,
    func_num
  ) {
    return [
      wasm.local$get, ...name,
      wasm.local$get, ...func_num,
      wasm.local$get, ...i32_args,
      wasm.local$get, ...i64_args,
      wasm.local$get, ...f64_args,
      wasm.local$get, ...result,
      wasm.call, ...funcs.uleb128.make_comp_func,
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...funcs.uleb128.store_binding
    ];
  }
);

compile();

/*------------*\
|              |
| finish types |
|              |
\*------------*/

const comp_types = new_atom(empty_vector);

for (const type_name in types) {
  const type_info = types[type_name];
  let _ts = comp.atom_swap_lock(comp_types);
  const type = comp.Type(type_info.type_num);
  let ts = comp.conj(_ts, type);
  comp.free(_ts);
  comp.atom_swap_set(comp_types, ts);
  comp.store_binding(make_symbol(type_name), type, global_env);
  const pred = pre_new_method(
    `${type_name}$instance`, 1, 0, 0, wasm.i32,
    { comp: [wrap_result_i32_to_bool] },
    () => [wasm.i32$const, 0]
  );
  pred.implement(type_info, () => [wasm.i32$const, 1]);
  type_info.predicate_leb128 = pred.func_idx_leb128;
}

/*-------*\
|         |
| methods |
|         |
\*-------*/

const methods = new_atom(empty_vector);

funcs.build("impl_def_func_all_methods",
  [wasm.i32], [], {},
  function (tpnm) {
    const mtds = this.local(wasm.i32),
          mtd = this.local(wasm.i32),
          cnt = this.local(wasm.i32),
          idx = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(methods),
      wasm.call, ...funcs.uleb128.atom_deref,
      wasm.local$tee, ...mtds,
      wasm.call, ...count.func_idx_leb128,
      wasm.local$set, ...cnt,
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...mtds,
          wasm.local$get, ...idx,
          wasm.i32$const, nil,
          wasm.call, ...nth.func_idx_leb128,
          wasm.local$tee, ...mtd,
          wasm.call, ...types.Method.fields.num.leb128,
          wasm.local$get, ...tpnm,
          wasm.local$get, ...mtd,
          wasm.call, ...types.Method.fields.default_func.leb128,
          wasm.call, ...impl_method.func_idx_leb128,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...idx,
          wasm.br, 1,
        wasm.end,
      wasm.end
    ];
  }
);

funcs.build("impl_def_func_all_types",
  [wasm.i32], [], { export: true },
  function (mtd) {
    const tps = this.local(wasm.i32),
          mtd_num = this.local(wasm.i32),
          def_fnc = this.local(wasm.i32),
          cnt = this.local(wasm.i32),
          idx = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(comp_types),
      wasm.call, ...funcs.uleb128.atom_deref,
      wasm.local$tee, ...tps,
      wasm.call, ...count.func_idx_leb128,
      wasm.local$set, ...cnt,
      wasm.local$get, ...mtd,
      wasm.call, ...types.Method.fields.num.leb128,
      wasm.local$set, ...mtd_num,
      wasm.local$get, ...mtd,
      wasm.call, ...types.Method.fields.default_func.leb128,
      wasm.local$set, ...def_fnc,
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...mtd_num,
          wasm.local$get, ...tps,
          wasm.local$get, ...idx,
          wasm.i32$const, nil,
          wasm.call, ...nth.func_idx_leb128,
          wasm.call, ...types.Type.fields.num.leb128,
          wasm.local$get, ...def_fnc,
          wasm.call, ...impl_method.func_idx_leb128,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...idx,
          wasm.br, 1,
        wasm.end,
      wasm.end
    ];
  }
);

funcs.build("store_method",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], { export: true },
  function (mtd_num, def_fnc, main_fnc) {
    const mtd = this.local(wasm.i32),
          mtds = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(methods),
      wasm.i32$const, ...sleb128i32(methods),
      wasm.call, ...funcs.uleb128.atom_swap_lock,
      wasm.local$tee, ...mtds,
      wasm.local$get, ...mtd_num,
      wasm.local$get, ...def_fnc,
      wasm.local$get, ...main_fnc,
      wasm.call, ...types.Method.constr.leb128,
      wasm.local$tee, ...mtd,
      wasm.call, ...conj.func_idx_leb128,
      wasm.call, ...funcs.uleb128.atom_swap_set,
      wasm.drop,
      wasm.local$get, ...mtds,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$get, ...mtd
    ];
  }
);

compile();

for (const m of defined_methods) {
  comp.store_method(m.mtd_num, m.def_func, m.func_idx);
}

// todo: only export when opts.export
function new_method (name, num_args, result, def_func) {
// todo: should all methods be exported? if not, don't pass name
  const out = def_mtd(name, num_args, 0, 0, result,  {}, def_func),
        mtd = comp.store_method(out.mtd_num, out.def_func, out.main_func);
  comp.impl_def_func_all_types(mtd);
  comp.store_binding(make_symbol(name), mtd, global_env);
  return out;
}

function new_method2 (name, num_args, result, opts, def_func) {
// todo: should all methods be exported? if not, don't pass name
  const out = def_mtd(name, num_args, 0, 0, result,  opts, def_func),
        mtd = comp.store_method(out.mtd_num, out.def_func, out.main_func);
  comp.impl_def_func_all_types(mtd);
  comp.store_binding(make_symbol(name), mtd, global_env);
  return out;
}

/*-----*\
|       |
| to_js |
|       |
\*-----*/

const to_js = new_method2("to_js", 1, wasm.i32, { comp: true });

to_js.implement(types.String, function (str) {
  return [
    wasm.local$get, ...str,
    wasm.call, ...store_string.func_idx_leb128,
    wasm.call, ...types.Object.constr.leb128
  ];
});

/*-----------*\
|             |
| deref/reset |
|             |
\*-----------*/

const deref = new_method("deref", 1, wasm.i32, { comp: true });

deref.implement(types.Atom, funcs.built.atom_deref.func_idx);

const reset = new_method("reset", 2, wasm.i32, { comp: true });

reset.implement(types.Atom, function (atom, val) {
  return [
    wasm.local$get, ...atom,
    wasm.local$get, ...val,
    wasm.local$get, ...atom,
    wasm.call, ...funcs.uleb128.atom_swap_lock,
    wasm.drop,
    wasm.call, ...funcs.uleb128.atom_swap_set,
  ];
});

/*----------*\
|            |
| comp funcs |
|            |
\*----------*/

funcs.build("cons",
  [wasm.i32, wasm.i32], [wasm.i32], { comp: true },
  function (val, coll) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.local$get, ...coll,
      wasm.call, ...to_seq.func_idx_leb128,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.call, ...types.ConsSeq.constr.leb128,
      wasm.call, ...types.Seq.constr.leb128
    ];
  }
);

comp.store_comp_func(
  make_symbol("array-get-i8"), 2, 0, 0, wasm.i64,
  func_builder(function (func) {
    const arr = func.param(wasm.i32),
          idx = func.param(wasm.i32);
    func.add_result(wasm.i64);
    func.append_code(
      wasm.local$get, ...idx,
      wasm.call, ...types.Int.fields.value.leb128,
      wasm.i32$wrap_i64,
      wasm.local$tee, ...idx,
      wasm.local$get, ...arr,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.i32$lt_u,
      wasm.if, wasm.i64,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.array_get_i8,
        wasm.i64$extend_i32_u,
      wasm.else,
        wasm.i32$const, 0,
        wasm.i32$const, ...sleb128i32(cached_string("array-get-i8")),
        wasm.call, ...types.Exception.constr.leb128,
        wasm.throw, 0,
      wasm.end
    );
  }).func_idx
);

comp.store_comp_func(
  make_symbol("array-set-i8"), 3, 0, 0, wasm.i32,
  func_builder(function (func) {
    const arr = func.param(wasm.i32),
          idx = func.param(wasm.i32),
          num = func.param(wasm.i32);
    func.add_result(wasm.i32);
    func.append_code(
      wasm.local$get, ...idx,
      wasm.call, ...types.Int.fields.value.leb128,
      wasm.i32$wrap_i64,
      wasm.local$tee, ...idx,
      wasm.local$get, ...arr,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.i32$lt_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx,
        wasm.local$get, ...num,
        wasm.call, ...types.Int.fields.value.leb128,
        wasm.i32$wrap_i64,
        wasm.call, ...funcs.uleb128.array_set_i8,
      wasm.else,
        wasm.i32$const, 0,
        wasm.i32$const, ...sleb128i32(cached_string("array-set-i8")),
        wasm.call, ...types.Exception.constr.leb128,
        wasm.throw, 0,
      wasm.end
    );
  }).func_idx
);

comp.store_comp_func(
  make_symbol("def"), 2, 0, 0, wasm.i32,
  func_builder(function (func) {
    const name = func.param(wasm.i32),
          val = func.param(wasm.i32);
    func.add_result(wasm.i32);
    func.append_code(
      wasm.local$get, ...name,
      wasm.local$get, ...val,
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...funcs.uleb128.store_binding,
      wasm.local$get, ...val
    );
  }).func_idx
);

comp.store_comp_func(
  make_symbol("atom"), 1, 0, 0, wasm.i32, func_builder(function (func) {
    const val = func.param(wasm.i32);
    func.add_result(wasm.i32);
    func.append_code(
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...types.Atom.constr.leb128
    );
  }).func_idx
);

comp.store_comp_func(
  make_symbol("defmethod"), 3, 0, 0, wasm.i32,
  func_builder(function (func) {
    const mtd_name = func.param(wasm.i32),
          num_args = func.param(wasm.i32),
          def_func = func.param(wasm.i32),
          mtd_func = func.local(wasm.i32),
          mtd_num = func.local(wasm.i32);
    func.add_result(wasm.i32);
    func.append_code(
      wasm.local$get, ...mtd_name,
      wasm.local$get, ...mtd_name,
      // expects no namespace (use $)
      wasm.call, ...types.Symbol.fields.name.leb128,
      wasm.call, ...store_string.func_idx_leb128,
      wasm.local$get, ...num_args,
      wasm.call, ...types.Int.fields.value.leb128,
      wasm.i32$wrap_i64,
      wasm.i32$const, 0,
      wasm.i32$const, 0,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...funcs.uleb128.new_comp_method,
      wasm.local$set, ...mtd_num,
      wasm.local$set, ...mtd_func,
      wasm.local$get, ...mtd_num,
      wasm.local$get, ...def_func,
// todo: why not just leave as Method?
      wasm.call, ...types.Method.predicate_leb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...def_func,
        wasm.call, ...types.Method.fields.main_func.leb128,
        wasm.call, ...types.Function.fields.func_num.leb128,
        wasm.local$tee, ...def_func,
      wasm.else,
        wasm.local$get, ...def_func,
      wasm.end,
      wasm.local$get, ...mtd_func,
      wasm.call, ...funcs.uleb128.store_method,
      wasm.call, ...funcs.uleb128.impl_def_func_all_types,
      wasm.local$get, ...mtd_num,
      wasm.local$get, ...def_func,
      wasm.local$get, ...mtd_func,
      wasm.call, ...types.Method.constr.leb128,
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...funcs.uleb128.store_binding,
      wasm.i32$const, nil
    )
  }).func_idx
);

funcs.build("get_next_type_num",
  [], [wasm.i32], {},
  function (func) {
    const ts = this.local(wasm.i32),
          type_num = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(comp_types),
      wasm.i32$const, ...sleb128i32(comp_types),
      wasm.call, ...funcs.uleb128.atom_swap_lock,
      wasm.local$tee, ...ts,
      wasm.local$get, ...ts,
      wasm.call, ...count.func_idx_leb128,
      wasm.local$tee, ...type_num,
      wasm.call, ...types.Type.constr.leb128,
      wasm.call, ...conj.func_idx_leb128,
      wasm.call, ...funcs.uleb128.atom_swap_set,
      wasm.drop,
      wasm.local$get, ...ts,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$get, ...type_num,
    ];
  }
);

comp.store_comp_func(
  make_symbol("deftype"), 2, 0, 0, wasm.i32,
  func_builder(function (func) {
    const type_name = func.param(wasm.i32),
          fields = func.param(wasm.i32),
          inner_constr = func.local(wasm.i32),
          outer_constr = func.local(wasm.i32),
          type_num = func.local(wasm.i32),
          type_size = func.local(wasm.i32),
          field_num = func.local(wasm.i32),
          param_num = func.local(wasm.i32),
          field_name = func.local(wasm.i32),
          get_func = func.local(wasm.i32);
    func.add_result(wasm.i32);
    func.append_code(
      wasm.local$get, ...type_name,
      // expects no namespace (use $)
      wasm.call, ...types.Symbol.fields.name.leb128,
      wasm.local$set, ...type_name,

      wasm.call, ...funcs.uleb128.start_type,
      wasm.local$set, ...outer_constr,
      wasm.local$set, ...inner_constr,

      wasm.call, ...funcs.uleb128.get_next_type_num,
      wasm.local$tee, ...type_num,
      wasm.call, ...funcs.uleb128.impl_def_func_all_methods,

      // type_num:
      wasm.local$get, ...inner_constr,
      wasm.local$get, ...outer_constr,
      wasm.local$get, ...type_size,
      wasm.local$get, ...field_num,
      wasm.local$get, ...param_num,
      wasm.i32$const, 0,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$const, 1,
      wasm.local$get, ...type_num,
      wasm.call, ...funcs.uleb128.add_type_field,
      wasm.local$set, ...get_func,
      wasm.local$set, ...param_num,
      wasm.local$set, ...field_num,
      wasm.local$set, ...type_size,

      // refs:
      wasm.local$get, ...inner_constr,
      wasm.local$get, ...outer_constr,
      wasm.local$get, ...type_size,
      wasm.local$get, ...field_num,
      wasm.local$get, ...param_num,
      wasm.i32$const, 0,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$const, 1,
      wasm.i32$const, 0,
      wasm.call, ...funcs.uleb128.add_type_field,
      wasm.local$set, ...get_func,
      wasm.local$set, ...param_num,
      wasm.local$set, ...field_num,
      wasm.local$set, ...type_size,

      // hash:
      wasm.local$get, ...inner_constr,
      wasm.local$get, ...outer_constr,
      wasm.local$get, ...type_size,
      wasm.local$get, ...field_num,
      wasm.local$get, ...param_num,
      wasm.i32$const, 0,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$const, 1,
      wasm.i32$const, 0,
      wasm.call, ...funcs.uleb128.add_type_field,
      wasm.local$set, ...get_func,
      wasm.local$set, ...param_num,
      wasm.local$set, ...field_num,
      wasm.local$set, ...type_size,

      wasm.loop, wasm.void,
        wasm.local$get, ...param_num,
        wasm.local$get, ...fields,
        wasm.call, ...count.func_idx_leb128,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...fields,
          wasm.local$get, ...param_num,
          wasm.i32$const, nil,
          wasm.call, ...nth.func_idx_leb128,
          wasm.call, ...types.Symbol.fields.name.leb128,
          wasm.local$set, ...field_name,

          wasm.local$get, ...inner_constr,
          wasm.local$get, ...outer_constr,
          wasm.local$get, ...type_size,
          wasm.local$get, ...field_num,
          wasm.local$get, ...param_num,
          wasm.i32$const, 0,
          wasm.i32$const, ...sleb128i32(wasm.i32),
          wasm.i32$const, 0,
          wasm.i32$const, 0,
          wasm.call, ...funcs.uleb128.add_type_field,
          wasm.local$set, ...get_func,
          wasm.local$set, ...param_num,
          wasm.local$set, ...field_num,
          wasm.local$set, ...type_size,

          wasm.local$get, ...type_name,
          wasm.i32$const, ...sleb128i32(cached_string("get-")),
          wasm.local$get, ...field_name,
          wasm.call, ...funcs.uleb128.concat_str,
          wasm.call, ...funcs.uleb128.symbol,
          wasm.i32$const, 1,
          wasm.i32$const, 0,
          wasm.i32$const, 0,
          wasm.i32$const, ...sleb128i32(wasm.i32),
          wasm.local$get, ...get_func,
          wasm.call, ...funcs.uleb128.store_comp_func,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...inner_constr,
      wasm.local$get, ...outer_constr,
      wasm.local$get, ...type_size,
      wasm.local$get, ...param_num,
      wasm.local$get, ...type_name,
      wasm.call, ...store_string.func_idx_leb128,
      wasm.call, ...funcs.uleb128.end_type,
      wasm.local$set, ...type_size,
      wasm.local$set, ...param_num,
      wasm.local$set, ...outer_constr,
      wasm.local$get, ...type_name,
      wasm.i32$const, ...sleb128i32(cached_string("new")),
      wasm.call, ...funcs.uleb128.symbol,
      wasm.local$get, ...param_num,
      wasm.i32$const, 0,
      wasm.i32$const, 0,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.local$get, ...outer_constr,
      wasm.call, ...funcs.uleb128.store_comp_func,
  
// todo: how to namespace this?
      wasm.i32$const, ...sleb128i32(nil),
      wasm.local$get, ...type_name,
      wasm.call, ...funcs.uleb128.symbol,
      wasm.local$get, ...type_num,
      wasm.call, ...types.Type.constr.leb128,
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...funcs.uleb128.store_binding,
      wasm.i32$const, nil
    );
  }).func_idx
);

comp.store_comp_func(
  make_symbol("impl"), 3, 0, 0, wasm.i32,
  func_builder(function (func) {
    const mtd = func.param(wasm.i32),
          typ = func.param(wasm.i32),
          fnc = func.param(wasm.i32);
    func.add_result(wasm.i32);
    func.append_code(
      wasm.local$get, ...mtd,
      wasm.call, ...types.Method.fields.num.leb128,
      wasm.local$get, ...typ,
      wasm.call, ...types.Type.fields.num.leb128,
      wasm.local$get, ...fnc,
      wasm.call, ...types.Function.fields.func_num.leb128,
      wasm.call, ...impl_method.func_idx_leb128,
      wasm.i32$const, nil
    );
  }).func_idx
);

/*----------*\
|            |
| free-local |
|            |
\*----------*/

const confirm_off_local_refs = new_method(null, 1, wasm.i32, function (val) {
  const prev = this.local(wasm.i32);
  return [
    wasm.local$get, ...val,
    wasm.i32$const, ...sleb128i32(0x40000000),
    wasm.local$get, ...val,
    wasm.i32$const, ...sleb128i32(0x80000000),
    wasm.i32$const, 0,
    wasm.call, ...funcs.uleb128.set_flag,
    wasm.local$tee, ...prev,
    wasm.call, ...funcs.uleb128.set_flag,
    wasm.drop,
    wasm.local$get, ...prev,
    wasm.if, wasm.i32,
      wasm.local$get, ...val,
    wasm.else,
      wasm.i32$const, 0,
    wasm.end
  ];
});

funcs.build("off_local_refs",
  [wasm.i32], [wasm.i32], {},
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...confirm_off_local_refs.func_idx_leb128,
      wasm.drop,
      wasm.local$get, ...val,
    ];
  }
);

const revert_local_refs = new_method(null, 1, 0, function (val) {
  return [
    wasm.local$get, ...val,
    wasm.i32$const, ...sleb128i32(0x80000000),
    wasm.local$get, ...val,
    wasm.i32$const, ...sleb128i32(0x40000000),
    wasm.i32$const, 0,
    wasm.call, ...funcs.uleb128.set_flag,
    wasm.call, ...funcs.uleb128.set_flag,
    wasm.drop
  ];
});

for (const type of [types.Nil, types.False, types.True]) {
  confirm_off_local_refs.implement(type, function () {
    return [wasm.i32$const, 0];
  });
  revert_local_refs.implement(type, () => []);
}

/*---------*\
|           |
| emit-code |
|           |
\*---------*/

const compile_form = func_builder();

funcs.build("lookup_ref",
  [wasm.i32], [wasm.i32], {},
  function (var_name) {
    const out = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...funcs.uleb128.atom_deref,
      wasm.local$get, ...var_name,
      wasm.i32$const, ...sleb128i32(no_entry),
      wasm.call, ...get.func_idx_leb128,
      wasm.local$tee, ...out,
      wasm.i32$const, ...sleb128i32(no_entry),
      wasm.i32$eq,
      wasm.if, wasm.void,
        wasm.local$get, ...var_name,
        wasm.i32$const, ...sleb128i32(cached_string("invalid reference: ")),
        wasm.local$get, ...var_name,
        wasm.call, ...types.Symbol.fields.name.leb128,
        wasm.call, ...funcs.uleb128.concat_str,
        wasm.call, ...types.Exception.constr.leb128,
        wasm.throw, 0,
      wasm.end,
      wasm.local$get, ...out
    ];
  }
);

funcs.build("emit_code_default",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (val, func, env) {
    return [
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...val,
      wasm.call, ...append_varsint32.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, ...funcs.uleb128.off_local_refs,
      wasm.call, ...append_varuint32.func_idx_leb128,
    ];
  }
);

const emit_code = new_method("emit_code", 3, wasm.i32, funcs.built.emit_code_default);

emit_code.implement(types.Symbol, function (sym, func, env) {
  const bdg_val = this.local(wasm.i32);
  return [
    wasm.local$get, ...env,
    wasm.local$get, ...sym,
    wasm.i32$const, nil,
    wasm.call, ...get.func_idx_leb128,
    wasm.local$tee, ...bdg_val,
    wasm.if, wasm.i32,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...bdg_val,
      wasm.call, ...types.Boxedi32.fields.value.leb128,
      wasm.call, ...append_varuint32.func_idx_leb128,
    wasm.else,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...sym,
      wasm.call, ...funcs.uleb128.lookup_ref,
      wasm.call, ...append_varsint32.func_idx_leb128,
    wasm.end
  ];
});

// todo: still need?
funcs.build("get_sig_type",
  [wasm.i32], [wasm.i32, wasm.i32], {},
  function (p) {
    const curr_type = this.local(wasm.i32);
    return [
      wasm.local$get, ...p,
      wasm.call, ...types.Metadata.predicate_leb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...p,
        wasm.call, ...types.Metadata.fields.meta.leb128,
        wasm.local$tee, ...curr_type,
        wasm.i32$const, ...sleb128i32(make_symbol("i64")),
        wasm.i32$eq,
        wasm.if, wasm.i32,
          wasm.i32$const, ...sleb128i32(wasm.i64),
        wasm.else,
          wasm.local$get, ...curr_type,
          wasm.i32$const, ...sleb128i32(make_symbol("f64")),
          wasm.i32$eq,
          wasm.if, wasm.i32,
            wasm.i32$const, ...sleb128i32(wasm.f64),
          wasm.else,
            wasm.local$get, ...curr_type,
            wasm.i32$const, ...sleb128i32(cached_string("invalid type notation")),
            wasm.call, ...types.Exception.constr.leb128,
            wasm.throw, 0,
          wasm.end,
        wasm.end,
        wasm.local$get, ...p,
        wasm.call, ...types.Metadata.fields.data.leb128,
        wasm.call, ...inc_refs.func_idx_leb128,
        wasm.local$set, ...p,
        wasm.local$get, ...p,
        wasm.call, ...free.func_idx_leb128,
      wasm.else,
        wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.end,
      wasm.local$get, ...p
    ];
  }
);

funcs.build("inc_locals",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (env, func, is_loc, loc_typ) {
    const loc_cnt = this.local(wasm.i32),
          locals = this.local(wasm.i32),
          arr = this.local(wasm.i32),
          cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...is_loc,
      wasm.if, wasm.void,
        wasm.local$get, ...func,
        wasm.local$get, ...loc_typ,
        wasm.call, ...add_local.func_idx_leb128,
        wasm.drop,
      wasm.else,
        wasm.local$get, ...func,
        wasm.local$get, ...loc_typ,
        wasm.call, ...add_param.func_idx_leb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("locals")),
      wasm.i32$const, nil,
      wasm.call, ...get.func_idx_leb128,
      wasm.local$tee, ...locals,
      wasm.local$get, ...locals,
      wasm.call, ...funcs.uleb128.atom_swap_lock,
      wasm.local$tee, ...arr,
      wasm.local$get, ...loc_typ,
      wasm.call, ...funcs.uleb128.array_push_i32,
      wasm.call, ...funcs.uleb128.atom_swap_set,
      wasm.drop,
      wasm.local$get, ...arr,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$get, ...arr,
      wasm.call, ...free.func_idx_leb128
    ];
  }
);

funcs.build("add_to_locals_to_free",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (loc, env, typ) {
    const box = this.local(wasm.i32),
          arr = this.local(wasm.i32),
          atm = this.local(wasm.i32);
   return [
      wasm.local$get, ...typ,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$eq,
      wasm.if, wasm.void,
        wasm.local$get, ...env,
        wasm.i32$const, ...sleb128i32(make_keyword("locals-to-free")),
        wasm.i32$const, nil,
        wasm.call, ...get.func_idx_leb128,
        wasm.local$tee, ...atm,
        wasm.local$get, ...atm,
        wasm.call, ...funcs.uleb128.atom_swap_lock,
        wasm.local$tee, ...arr,
        wasm.local$get, ...loc,
        wasm.call, ...funcs.uleb128.array_push_i32,
        wasm.call, ...funcs.uleb128.atom_swap_set,
        wasm.drop,
        wasm.local$get, ...arr,
        wasm.call, ...free.func_idx_leb128,
      wasm.end,
      wasm.local$get, ...loc
   ];
  }
);

funcs.build("get_locals_array",
  [wasm.i32], [wasm.i32], {},
  function (env) {
   return [
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("locals")),
      wasm.i32$const, nil,
      wasm.call, ...get.func_idx_leb128,
      wasm.call, ...funcs.uleb128.atom_deref
   ];
  }
);

funcs.build("get_locals_to_free",
  [wasm.i32], [wasm.i32], {},
  function (env) {
    return [
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("locals-to-free")),
      wasm.i32$const, nil,
      wasm.call, ...get.func_idx_leb128,
      wasm.call, ...funcs.uleb128.atom_deref
    ];
  }
);

funcs.build("comp_func_set_params",
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  {},
  function (func, config, env) {
    const params = this.local(wasm.i32),
          curr_param = this.local(wasm.i32),
          curr_type = this.local(wasm.i32),
          param_count = this.local(wasm.i32),
          param_index = this.local(wasm.i32),
          result = this.local(wasm.i32),
          i32_count = this.local(wasm.i32),
          i64_count = this.local(wasm.i32),
          f64_count = this.local(wasm.i32);
    return [
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("locals")),
      wasm.i32$const, 0,
      wasm.call, ...funcs.uleb128.array_by_length,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...types.Atom.constr.leb128,
      wasm.call, ...assoc.func_idx_leb128,
      wasm.local$tee, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("locals-to-free")),
      wasm.i32$const, 0,
      wasm.call, ...funcs.uleb128.array_by_length,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...types.Atom.constr.leb128,
      wasm.call, ...assoc.func_idx_leb128,
      wasm.local$get, ...env,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$tee, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("revert-local-refs")),
      wasm.i32$const, nil,
      wasm.call, ...assoc.func_idx_leb128,
// todo: need to confirm map has changed before freeing
      // wasm.local$get, ...env,
      // wasm.call, ...free.func_idx_leb128,
      wasm.local$set, ...env,
      wasm.local$get, ...func,
      wasm.local$get, ...config,
// todo: add name & type to config map
      wasm.call, ...funcs.uleb128.get_sig_type,
      wasm.local$set, ...config,
      wasm.local$tee, ...result,
      wasm.call, ...add_result.func_idx_leb128,
      wasm.drop,
      wasm.local$get, ...config,
      wasm.call, ...types.Vector.predicate_leb128,
      wasm.if, wasm.i32,
        wasm.i32$const, ...sleb128i32(empty_hash_map),
        wasm.i32$const, ...sleb128i32(make_keyword("params")),
        wasm.local$get, ...config,
        wasm.call, ...assoc.func_idx_leb128,
      wasm.else,
        wasm.local$get, ...config,
      wasm.end,
      wasm.local$tee, ...config,
      wasm.i32$const, ...sleb128i32(make_keyword("params")),
      wasm.i32$const, nil,
      wasm.call, ...get.func_idx_leb128,
      wasm.local$tee, ...params,
      wasm.call, ...count.func_idx_leb128,
      wasm.local$tee, ...param_count,
      wasm.if, wasm.void,
        wasm.loop, wasm.void,
          wasm.local$get, ...param_index,
          wasm.local$get, ...param_count,
          wasm.i32$lt_u,
          wasm.if, wasm.void,
            wasm.local$get, ...params,
            wasm.local$get, ...param_index,
            wasm.i32$const, nil,
            wasm.call, ...nth.func_idx_leb128,
            wasm.call, ...funcs.uleb128.get_sig_type,
            wasm.local$set, ...curr_param,
            wasm.local$set, ...curr_type,
            // stage to free:
            wasm.local$get, ...env,
            wasm.local$get, ...env,
            wasm.local$get, ...curr_param,
            wasm.local$get, ...param_index,
            wasm.call, ...types.Boxedi32.constr.leb128,
            wasm.call, ...assoc.func_idx_leb128,
            wasm.local$tee, ...env,
            wasm.local$get, ...func,
            wasm.i32$const, 0,
            wasm.local$get, ...curr_type,
            wasm.call, ...funcs.uleb128.inc_locals,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...param_index,
            // free env
            wasm.call, ...free.func_idx_leb128,
            wasm.local$get, ...curr_type,
            wasm.i32$const, ...sleb128i32(wasm.i32),
            wasm.i32$eq,
            wasm.if, wasm.void,
              wasm.local$get, ...i32_count,
              wasm.i32$const, 1,
              wasm.i32$add,
              wasm.local$set, ...i32_count,
            wasm.else,
              wasm.local$get, ...curr_type,
              wasm.i32$const, ...sleb128i32(wasm.i64),
              wasm.i32$eq,
              wasm.if, wasm.void,
                wasm.local$get, ...i64_count,
                wasm.i32$const, 1,
                wasm.i32$add,
                wasm.local$set, ...i64_count,
              wasm.else,
                wasm.local$get, ...curr_type,
                wasm.i32$const, ...sleb128i32(wasm.f64),
                wasm.i32$eq,
                wasm.if, wasm.void,
                  wasm.local$get, ...f64_count,
                  wasm.i32$const, 1,
                  wasm.i32$add,
                  wasm.local$set, ...f64_count,
                wasm.end,
              wasm.end,
            wasm.end,
            wasm.br, 1,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.local$get, ...env,
      wasm.local$get, ...config,
      wasm.local$get, ...result,
      wasm.local$get, ...i32_count,
      wasm.local$get, ...i64_count,
      wasm.local$get, ...f64_count
    ];
  }
);

const is_num64 = new_method(null, 2, wasm.i32, function (val, env) {
  return [wasm.i32$const, 0];
});

is_num64.implement(types.Symbol, function (sym, env) {
  const loc_num = this.local(wasm.i32),
        typ = this.local(wasm.i32);
  return [
    wasm.local$get, ...env,
    wasm.local$get, ...sym,
    wasm.i32$const, nil,
    wasm.call, ...get.func_idx_leb128,
    wasm.local$tee, ...loc_num,
    wasm.if, wasm.i32,
      wasm.local$get, ...env,
      wasm.call, ...funcs.uleb128.get_locals_array,
      wasm.local$get, ...loc_num,
      wasm.call, ...types.Boxedi32.fields.value.leb128,
      wasm.call, ...funcs.uleb128.array_get_i32,
      wasm.local$tee, ...typ,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.i32$const, 0,
      wasm.else,
        wasm.local$get, ...typ,
      wasm.end,
    wasm.else,
      wasm.i32$const, 0,
    wasm.end
  ];
});

is_num64.implement(types.Seq, function (list, env) {
  const sym = this.local(wasm.i32),
        ns = this.local(wasm.i32),
        func_record = this.local(wasm.i32),
        result = this.local(wasm.i32);
  return [
    wasm.local$get, ...list,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$tee, ...sym,
    wasm.call, ...types.Symbol.predicate_leb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...sym,
      wasm.i32$const, ...sleb128i32(make_symbol("set-local")),
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...list,
        wasm.call, ...rest.func_idx_leb128,
        wasm.call, ...first.func_idx_leb128,
        wasm.local$get, ...env,
        wasm.call, ...is_num64.func_idx_leb128,
      wasm.else,
        wasm.local$get, ...sym,
        wasm.call, ...types.Symbol.fields.namespace.leb128,
        wasm.local$tee, ...ns,
        wasm.if, wasm.i32,
          wasm.local$get, ...ns,
          wasm.i32$const, ...sleb128i32(cached_string("i64")),
          wasm.call, ...funcs.uleb128.eq,
          wasm.if, wasm.i32,
            wasm.i32$const, ...sleb128i32(wasm.i64),
          wasm.else,
            wasm.local$get, ...ns,
            wasm.i32$const, ...sleb128i32(cached_string("f64")),
            wasm.call, ...funcs.uleb128.eq,
            wasm.if, wasm.i32,
              wasm.i32$const, ...sleb128i32(wasm.f64),
            wasm.else,
              wasm.i32$const, 0,
            wasm.end,
          wasm.end,
        wasm.else,
          wasm.i32$const, 0,
        wasm.end,
        wasm.local$tee, ...result,
        wasm.if, wasm.i32,
          wasm.local$get, ...result,
        wasm.else,
          wasm.local$get, ...sym,
          wasm.call, ...funcs.uleb128.lookup_ref,
          wasm.local$tee, ...func_record,
          wasm.call, ...types.Function.predicate_leb128,
          wasm.if, wasm.i32,
            wasm.local$get, ...func_record,
            wasm.call, ...types.Function.fields.result.leb128,
            wasm.local$tee, ...result,
            wasm.i32$const, ...sleb128i32(wasm.i64),
            wasm.i32$eq,
            wasm.local$get, ...result,
            wasm.i32$const, ...sleb128i32(wasm.f64),
            wasm.i32$eq,
            wasm.i32$or,
            wasm.if, wasm.i32,
              wasm.local$get, ...result,
            wasm.else,
              wasm.i32$const, 0,
            wasm.end,
          wasm.else,
            wasm.i32$const, 0,
          wasm.end,
        wasm.end,
      wasm.end,
    wasm.else,
      wasm.i32$const, 0,
    wasm.end
  ];
});

let special_forms = empty_hash_map;

function def_special_form (sym, fn) {
  const sf = special_forms;
  if (typeof sym === "string") sym = make_symbol(sym);
  if (fn instanceof Function) fn = func_builder(fn);
  special_forms = comp.assoc(
    special_forms, sym,
    comp.make_comp_func(fn.func_idx, 3, 0, 0, wasm.i32)
  );
  // allows is_num64 to work when detecting type of local in let
  comp.store_binding(sym, nil, global_env);
  comp.free(sf);
}

funcs.build("comp_func_add_local",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (func, env, bdg, val) {
    const typ = this.local(wasm.i32),
          local_idx = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...emit_code.func_idx_leb128,
      wasm.drop,
      wasm.local$get, ...val,
      wasm.call, ...types.Seq.predicate_leb128,
      wasm.local$get, ...val,
      wasm.local$get, ...env,
      wasm.call, ...is_num64.func_idx_leb128,
      wasm.local$tee, ...typ,
      wasm.if, wasm.i32,
        wasm.local$get, ...typ,
      wasm.else,
        wasm.i32$const, ...sleb128i32(wasm.i32),
        wasm.local$tee, ...typ,
      wasm.end,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$eq,
      wasm.i32$and,
      wasm.if, wasm.void,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.drop),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.drop,
        wasm.local$get, ...env,
        wasm.call, ...funcs.uleb128.get_locals_array,
        wasm.call, ...types.Array.fields.length.leb128,
        wasm.i32$const, 1,
        wasm.i32$sub,
        wasm.local$set, ...local_idx,
      wasm.else,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.local$set),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.local$get, ...env,
        wasm.local$get, ...func,
        wasm.i32$const, 1,
        wasm.local$get, ...typ,
        wasm.call, ...funcs.uleb128.inc_locals,
        wasm.local$tee, ...local_idx,
        wasm.call, ...append_varuint32.func_idx_leb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...env,
      wasm.local$get, ...bdg,
      wasm.local$get, ...local_idx,
      wasm.call, ...types.Boxedi32.constr.leb128,
      wasm.call, ...assoc.func_idx_leb128
    ];
  }
);

funcs.build("stage_val_to_free",
  [wasm.i32, wasm.i32], [], {},
  function (func, env) {
    const loc_num = this.local(wasm.i32),
          revert_outer = this.local(wasm.i32),
          revert_outer_idx = this.local(wasm.i32);
    return [
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, ...inc_refs.func_idx_leb128,
      wasm.call, ...append_varsint32.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.local$tee),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...env,
      wasm.local$get, ...func,
      wasm.i32$const, 1,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...funcs.uleb128.inc_locals,
      wasm.local$tee, ...loc_num,
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...funcs.uleb128.add_to_locals_to_free,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.drop,
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("revert-local-refs")),
      wasm.i32$const, nil,
      wasm.call, ...get.func_idx_leb128,
      wasm.local$tee, ...revert_outer,
      wasm.if, wasm.void,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.i32$const, ...funcs.uleb128.off_local_refs,
        wasm.call, ...append_varuint32.func_idx_leb128,
        wasm.drop,
        wasm.local$get, ...revert_outer,
        wasm.i32$const, 0,
        wasm.local$get, ...revert_outer,
        wasm.i32$const, 0,
        wasm.call, ...funcs.uleb128.array_get_i32,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.local$tee, ...revert_outer_idx,
        wasm.call, ...funcs.uleb128.array_set_i32,
        wasm.local$get, ...revert_outer_idx,
        wasm.local$get, ...loc_num,
        wasm.call, ...funcs.uleb128.array_set_i32,
        wasm.drop,
      wasm.end
    ];
  }
);

funcs.build("emit_func_call",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32], [], {},
  function (func, env, func_record, args, is_func) {
    const cnt = this.local(wasm.i32),
          revert_inner = this.local(wasm.i32),
          revert_inner_idx = this.local(wasm.i32),
          inner_env = this.local(wasm.i32),
          result = this.local(wasm.i32),
          func_num = this.local(wasm.i32);
    return [
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("revert-local-refs")),
      wasm.local$get, ...args,
      wasm.call, ...count.func_idx_leb128,
      wasm.local$tee, ...cnt,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.call, ...funcs.uleb128.array_by_length,
      wasm.local$tee, ...revert_inner,
      wasm.call, ...assoc.func_idx_leb128,
      wasm.local$set, ...inner_env,
      wasm.loop, wasm.void,
        wasm.local$get, ...args,
        wasm.call, ...count.func_idx_leb128,
        wasm.if, wasm.void,
          wasm.local$get, ...args,
          wasm.call, ...first.func_idx_leb128,
          wasm.local$get, ...func,
          wasm.local$get, ...inner_env,
          wasm.call, ...emit_code.func_idx_leb128,
          wasm.drop,
          wasm.local$get, ...args,
          wasm.local$get, ...args,
          wasm.call, ...rest.func_idx_leb128,
          wasm.local$set, ...args,
          wasm.call, ...free.func_idx_leb128,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...inner_env,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$get, ...is_func,
      wasm.if, wasm.void,
        wasm.local$get, ...func_record,
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.call, ...emit_code.func_idx_leb128,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.i32$const, ...types.Function.fields.tbl_idx.leb128,
        wasm.call, ...append_varuint32.func_idx_leb128,
        wasm.i32$const, ...sleb128i32(wasm.call_indirect),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.local$get, ...cnt,
        wasm.i32$const, 0,
        wasm.i32$const, 0,
        wasm.i32$const, ...sleb128i32(wasm.i32),
        wasm.call, ...get_type_idx.func_idx_leb128,
        wasm.call, ...append_varuint32.func_idx_leb128,
        wasm.i32$const, 0,
        wasm.call, ...append_varuint32.func_idx_leb128,
        wasm.drop,
      wasm.else,
        wasm.local$get, ...func_record,
        wasm.call, ...types.Method.predicate_leb128,
        wasm.if, wasm.i32,
          wasm.local$get, ...func_record,
          wasm.call, ...types.Method.fields.main_func.leb128,
        wasm.else,
          wasm.local$get, ...func_record,
        wasm.end,
        wasm.local$tee, ...func_record,
        wasm.call, ...types.Function.fields.result.leb128,
        wasm.local$set, ...result,
        wasm.local$get, ...func_record,
        wasm.call, ...types.Function.fields.func_num.leb128,
        wasm.local$set, ...func_num,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.local$get, ...func_num,
        wasm.call, ...append_varuint32.func_idx_leb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...result,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$eq,
      wasm.if, wasm.void,
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.call, ...funcs.uleb128.stage_val_to_free,
      wasm.end,
      wasm.local$get, ...revert_inner,
      wasm.i32$const, 0,
      wasm.call, ...funcs.uleb128.array_get_i32,
      wasm.local$set, ...revert_inner_idx,
      wasm.loop, wasm.void,
        wasm.local$get, ...revert_inner_idx,
        wasm.if, wasm.void,
          wasm.local$get, ...func,
          wasm.i32$const, ...sleb128i32(wasm.local$get),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.local$get, ...revert_inner,
          wasm.local$get, ...revert_inner_idx,
          wasm.call, ...funcs.uleb128.array_get_i32,
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(wasm.call),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.i32$const, ...revert_local_refs.func_idx_leb128,
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.drop,
          wasm.local$get, ...revert_inner_idx,
          wasm.i32$const, 1,
          wasm.i32$sub,
          wasm.local$set, ...revert_inner_idx,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...revert_inner,
      wasm.call, ...free.func_idx_leb128,
    ];
  }
);

def_special_form("call", function (func) {
  const fn = func.param(wasm.i32),
        args = func.param(wasm.i32),
        env = func.param(wasm.i32);
  func.add_result(wasm.i32);
  func.append_code(
    wasm.local$get, ...fn,
    wasm.local$get, ...env,
    wasm.local$get, ...args,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$get, ...args,
    wasm.call, ...rest.func_idx_leb128,
    wasm.i32$const, 1,
    wasm.call, ...funcs.uleb128.emit_func_call,
    wasm.local$get, ...fn,
  );
});

def_special_form("let", function (_func) {
  const func = _func.param(wasm.i32),
        forms = _func.param(wasm.i32),
        env = _func.param(wasm.i32),
        bdgs = _func.local(wasm.i32),
        bdgs_cnt = _func.local(wasm.i32),
        bdg_idx = _func.local(wasm.i32);
  _func.add_result(wasm.i32);
  _func.append_code(
    wasm.local$get, ...forms,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$tee, ...bdgs,
    wasm.call, ...types.Vector.fields.count.leb128,
    wasm.local$tee, ...bdgs_cnt,
    wasm.if, wasm.void,
      wasm.local$get, ...env,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.drop,
      wasm.loop, wasm.void,
        wasm.local$get, ...bdg_idx,
        wasm.local$get, ...bdgs_cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...func,
          wasm.local$get, ...env,
          wasm.local$get, ...bdgs,
          wasm.local$get, ...bdg_idx,
          wasm.i32$const, nil,
          wasm.call, ...nth.func_idx_leb128,
          wasm.local$get, ...bdgs,
          wasm.local$get, ...bdg_idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.i32$const, nil,
          wasm.call, ...nth.func_idx_leb128,
          wasm.call, ...funcs.uleb128.comp_func_add_local,
          wasm.local$get, ...env,
          wasm.call, ...free.func_idx_leb128,
          wasm.local$set, ...env,
          wasm.local$get, ...bdg_idx,
          wasm.i32$const, 2,
          wasm.i32$add,
          wasm.local$set, ...bdg_idx,
          wasm.br, 1,
        wasm.end,
      wasm.end,
    wasm.end,
    wasm.local$get, ...forms,
    wasm.call, ...rest.func_idx_leb128,
    wasm.local$tee, ...forms,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$get, ...forms,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code.func_idx_leb128
  );
});

funcs.build("free_locals",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (func, env) {
    const locals = this.local(wasm.i32),
          idx = this.local(wasm.i32),
          local = this.local(wasm.i32),
          cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...env,
      wasm.call, ...funcs.uleb128.get_locals_to_free,
      wasm.local$tee, ...locals,
      wasm.call, ...types.Array.fields.length.leb128,
      wasm.local$set, ...cnt,
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...func,
          wasm.i32$const, ...sleb128i32(wasm.local$get),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.local$get, ...locals,
          wasm.local$get, ...idx,
          wasm.call, ...funcs.uleb128.array_get_i32,
          wasm.local$tee, ...local,
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(wasm.call),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.i32$const, ...confirm_off_local_refs.func_idx_leb128,
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(wasm.if),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(wasm.void),
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(wasm.local$get),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.local$get, ...local,
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(wasm.call),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(free.func_idx),
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(wasm.end),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(wasm.local$get),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.local$get, ...local,
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(wasm.call),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(free.func_idx),
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.drop,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...idx,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...func
    ];
  }
);

funcs.build("comp_func",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (func, xpt, form, env) {
    const inner_env = this.local(wasm.i32),
          name = this.local(wasm.i32),
          params = this.local(wasm.i32),
          config = this.local(wasm.i32),
          result = this.local(wasm.i32),
          i32_count = this.local(wasm.i32),
          i64_count = this.local(wasm.i32),
          f64_count = this.local(wasm.i32),
          func_idx = this.local(wasm.i32),
          func_num = this.local(wasm.i32),
          last_form = this.local(wasm.i32),
          fn = this.local(wasm.i32),
          scope = this.local(wasm.i32);
    return [
      wasm.local$get, ...form,
      wasm.call, ...first.func_idx_leb128,
      wasm.local$set, ...name,
      wasm.local$get, ...form,
      wasm.call, ...rest.func_idx_leb128,
      wasm.local$get, ...form,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$tee, ...form,
      wasm.call, ...first.func_idx_leb128,
      wasm.local$set, ...params,
      wasm.call, ...start_func.func_idx_leb128,
      wasm.local$tee, ...func_idx,
      wasm.local$get, ...params,
      wasm.local$get, ...env,
      wasm.call, ...funcs.uleb128.comp_func_set_params,
      wasm.local$set, ...f64_count,
      wasm.local$set, ...i64_count,
      wasm.local$set, ...i32_count,
      wasm.local$set, ...result,
      wasm.local$set, ...config,
      wasm.local$set, ...inner_env,
      wasm.local$get, ...func_idx,
      wasm.call, ...get_func_num.func_idx_leb128,
      wasm.local$tee, ...func_num,
      wasm.local$get, ...func_num,
      wasm.call, ...add_to_func_table.func_idx_leb128,
      wasm.local$get, ...i32_count,
      wasm.local$get, ...i64_count,
      wasm.local$get, ...f64_count,
      wasm.local$get, ...result,
      wasm.call, ...get_type_idx.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.local$get, ...i32_count,
      wasm.local$get, ...i64_count,
      wasm.local$get, ...f64_count,
      wasm.call, ...types.Function.constr.leb128,
      wasm.local$set, ...fn,
      wasm.local$get, ...func_idx,
      wasm.local$get, ...inner_env,
      wasm.local$get, ...name,
      wasm.local$get, ...fn,
      wasm.call, ...funcs.uleb128.comp_func_add_local,
      wasm.local$get, ...inner_env,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$set, ...inner_env,
      wasm.local$get, ...xpt,
      wasm.if, wasm.void,
        wasm.local$get, ...func_idx,
        wasm.local$get, ...name,
        wasm.call, ...types.Symbol.fields.name.leb128,
        wasm.call, ...store_string.func_idx_leb128,
        wasm.call, ...set_export.func_idx_leb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...form,
      wasm.call, ...rest.func_idx_leb128,
      wasm.local$get, ...form,
      wasm.call, ...free.func_idx_leb128,
      wasm.call, ...first.func_idx_leb128,
      wasm.local$get, ...func_idx,
      wasm.local$get, ...inner_env,
      wasm.call, ...emit_code.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, ...inc_refs.func_idx_leb128,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.local$get, ...inner_env,
      wasm.call, ...funcs.uleb128.free_locals,
      wasm.call, ...end_func.func_idx_leb128,
      wasm.drop,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...fn,
      wasm.call, ...append_varsint32.func_idx_leb128,
      wasm.local$get, ...config,
      wasm.i32$const, ...sleb128i32(make_keyword("scope")),
      wasm.i32$const, nil,
      wasm.call, ...get.func_idx_leb128,
      wasm.local$tee, ...scope,
      wasm.if, wasm.void,
        wasm.local$get, ...scope,
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.call, ...emit_code.func_idx_leb128,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.i32$const, ...to_seq.func_idx_leb128,
        wasm.call, ...append_varsint32.func_idx_leb128,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.i32$const, ...inc_refs.func_idx_leb128,
        wasm.call, ...append_varsint32.func_idx_leb128,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.i32$const, ...types.VariadicFunction.constr.leb128,
        wasm.call, ...append_varsint32.func_idx_leb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...funcs.uleb128.stage_val_to_free,
    ];
  }
);

funcs.build("inc_loop_depth",
  [wasm.i32], [wasm.i32], {},
  function (env) {
    const box = this.local(wasm.i32),
          kw = sleb128i32(make_keyword("loop-depth"));
    return [
      wasm.local$get, ...env,
      wasm.i32$const, ...kw,
      wasm.i32$const, nil,
      wasm.call, ...get.func_idx_leb128,
      wasm.local$tee, ...box,
      wasm.if, wasm.i32,
        wasm.local$get, ...env,
        wasm.i32$const, ...kw,
        wasm.local$get, ...box,
        wasm.call, ...types.Boxedi32.fields.value.leb128,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.call, ...types.Boxedi32.constr.leb128,
        wasm.call, ...assoc.func_idx_leb128,
      wasm.else,
        wasm.local$get, ...env,
        wasm.call, ...inc_refs.func_idx_leb128,
      wasm.end
    ];
  }
);

def_special_form("loop", function (_func) {
  const func = _func.param(wasm.i32),
        forms = _func.param(wasm.i32),
        env = _func.param(wasm.i32);
  _func.add_result(wasm.i32);
  _func.append_code(
    wasm.local$get, ...forms,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.loop),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.local$get, ...env,
    wasm.i32$const, ...sleb128i32(make_keyword("loop-depth")),
    wasm.i32$const, 0,
    wasm.call, ...types.Boxedi32.constr.leb128,
    wasm.call, ...assoc.func_idx_leb128,
    wasm.local$tee, ...env,
    wasm.call, ...emit_code.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(wasm.end),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.local$get, ...env,
    wasm.call, ...free.func_idx_leb128
  );
});

funcs.build("to_bool_i32",
  [wasm.i32], [wasm.i32], {},
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.i32$const, ...sleb128i32(comp_false),
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.i32$const, 0,
      wasm.else,
        // nil is zero, so no other check needed
        wasm.local$get, ...val,
      wasm.end
    ];
  }
);

def_special_form("if", function (_func) {
  const func = _func.param(wasm.i32),
        forms = _func.param(wasm.i32),
        env = _func.param(wasm.i32),
        cond = _func.local(wasm.i32);
  _func.add_result(wasm.i32);
  _func.append_code(
    wasm.local$get, ...forms,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$tee, ...cond,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...funcs.uleb128.inc_loop_depth,
    wasm.local$tee, ...env,
    wasm.call, ...emit_code.func_idx_leb128,
    wasm.drop,
    wasm.local$get, ...cond,
    wasm.local$get, ...env,
    wasm.call, ...is_num64.func_idx_leb128,
    wasm.local$tee, ...cond,
    wasm.i32$const, ...sleb128i32(wasm.i64),
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.i32$wrap_i64),
      wasm.call, ...append_code.func_idx_leb128,
    wasm.else,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, ...funcs.uleb128.to_bool_i32,
      wasm.call, ...append_varuint32.func_idx_leb128,
    wasm.end,
    wasm.i32$const, ...sleb128i32(wasm.if),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.drop,
    wasm.local$get, ...forms,
    wasm.call, ...rest.func_idx_leb128,
    wasm.local$tee, ...forms,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(wasm.else),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.drop,
    wasm.local$get, ...forms,
    wasm.call, ...rest.func_idx_leb128,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(wasm.end),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.local$get, ...env,
    wasm.call, ...free.func_idx_leb128
  );
});

// def_special_form("try", function (func) {
//   const fn = func.param(wasm.i32),
//         forms = func.param(wasm.i32),
//         env = func.param(wasm.i32);
//   func.add_result(wasm.i32);
//   func.append_code(
//     wasm.local$get, ...forms,
//     wasm.call, ...first.func_idx_leb128,
//     wasm.local$get, ...func,
//     wasm.i32$const, ...sleb128i32(wasm.throw),
//     
//     wasm.local$get, ...env,
//     wasm.call, ...emit_code.func_idx_leb128,
//   );
// });

def_special_form("throw", function (_func) {
  const func = _func.param(wasm.i32),
        forms = _func.param(wasm.i32),
        env = _func.param(wasm.i32);
  _func.add_result(wasm.i32);
  _func.append_code(
    wasm.local$get, ...forms,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code.func_idx_leb128,
    wasm.drop,
    wasm.local$get, ...forms,
    wasm.call, ...rest.func_idx_leb128,
    wasm.local$get, ...forms,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$tee, ...forms,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code.func_idx_leb128,
    wasm.drop,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.call),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(types.Exception.constr.func_idx),
    wasm.call, ...append_varuint32.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(wasm.throw),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.i32$const, 0,
    wasm.call, ...append_varuint32.func_idx_leb128,
    wasm.local$get, ...forms,
    wasm.call, ...free.func_idx_leb128,
  );
});

def_special_form("set-local", function (_func) {
  const func = _func.param(wasm.i32),
        forms = _func.param(wasm.i32),
        env = _func.param(wasm.i32),
        loc_num = _func.local(wasm.i32),
        val = _func.local(wasm.i32);
  _func.add_result(wasm.i32);
  _func.append_code(
    wasm.local$get, ...env,
    wasm.call, ...funcs.uleb128.get_locals_array,
    wasm.local$get, ...env,
    wasm.local$get, ...forms,
    wasm.call, ...first.func_idx_leb128,
    wasm.i32$const, nil,
    wasm.call, ...get.func_idx_leb128,
    wasm.call, ...types.Boxedi32.fields.value.leb128,
    wasm.local$tee, ...loc_num,
    wasm.call, ...funcs.uleb128.array_get_i32,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.i32$eq,
    wasm.local$get, ...forms,
    wasm.call, ...rest.func_idx_leb128,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$tee, ...val,
    wasm.local$get, ...env,
    wasm.call, ...is_num64.func_idx_leb128,
    wasm.i32$eqz,
    wasm.i32$or,
    wasm.if, wasm.i32,
      wasm.i32$const, 0,
      wasm.i32$const, ...sleb128i32(cached_string("set-local can only be used for i64 or f64")),
      wasm.call, ...types.Exception.constr.leb128,
      wasm.throw, 0,
    wasm.else,
      wasm.local$get, ...val,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...emit_code.func_idx_leb128,
      wasm.i32$const, ...sleb128i32(wasm.local$tee),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...loc_num,
      wasm.call, ...append_varuint32.func_idx_leb128,
    wasm.end
  );
});

def_special_form("recur", function (_func) {
  const func = _func.param(wasm.i32),
        forms = _func.param(wasm.i32),
        env = _func.param(wasm.i32);
  _func.add_result(wasm.i32);
  _func.append_code(
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.br),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.local$get, ...env,
    wasm.i32$const, ...sleb128i32(make_keyword("loop-depth")),
    wasm.i32$const, nil,
    wasm.call, ...get.func_idx_leb128,
    wasm.call, ...types.Boxedi32.fields.value.leb128,
    wasm.call, ...append_varuint32.func_idx_leb128
  );
});

def_special_form(make_symbol(nil, "Float$value"), function (_func) {
  const func = _func.param(wasm.i32),
        args = _func.param(wasm.i32),
        env = _func.param(wasm.i32),
        num = _func.local(wasm.i32),
        val = _func.local(wasm.i64),
        cnt = _func.local(wasm.i32);
  _func.add_result(wasm.i32);
  _func.append_code(
    wasm.local$get, ...args,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$tee, ...num,
    wasm.call, ...types.Float.predicate_leb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.f64$const),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...num,
      wasm.call, ...types.Float.fields.value.leb128,
      wasm.i64$reinterpret_f64,
      wasm.local$set, ...val,
      wasm.i32$const, 8,
      wasm.local$set, ...cnt,
      wasm.loop, wasm.void,
        wasm.local$get, ...func,
        wasm.i64$const, ...sleb128i64(0b11111111),
        wasm.local$get, ...val,
        wasm.i64$and,
        wasm.i32$wrap_i64,
        wasm.call, ...append_code.func_idx_leb128,
        wasm.drop,
        wasm.local$get, ...val,
        wasm.i64$const, 8,
        wasm.i64$shr_u,
        wasm.local$set, ...val,
        wasm.local$get, ...cnt,
        wasm.i32$const, 1,
        wasm.i32$sub,
        wasm.local$tee, ...cnt,
        wasm.br_if, 0,
      wasm.end,
    wasm.else,
      wasm.i32$const, 0,
    wasm.end
  );
});

def_special_form(make_symbol(nil, "Int$value"), function (_func) {
  const func = _func.param(wasm.i32),
        args = _func.param(wasm.i32),
        env = _func.param(wasm.i32),
        num = _func.local(wasm.i32);
  _func.add_result(wasm.i32);
  _func.append_code(
    wasm.local$get, ...args,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$tee, ...num,
    wasm.call, ...types.Int.predicate_leb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.i64$const),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...num,
      wasm.call, ...types.Int.fields.value.leb128,
      wasm.call, ...append_varsint64.func_idx_leb128,
    wasm.else,
      wasm.i32$const, 0,
    wasm.end
  );
});

def_special_form("do", function (_func) {
  const func = _func.param(wasm.i32),
        forms = _func.param(wasm.i32),
        env = _func.param(wasm.i32);
  _func.add_result(wasm.i32);
  _func.append_code(
    wasm.local$get, ...env,
    wasm.call, ...funcs.uleb128.inc_loop_depth,
    wasm.local$set, ...env,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.block),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.loop, wasm.void,
      wasm.local$get, ...forms,
      wasm.call, ...first.func_idx_leb128,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...emit_code.func_idx_leb128,
      wasm.drop,
      wasm.local$get, ...forms,
      wasm.call, ...rest.func_idx_leb128,
      wasm.local$tee, ...forms,
      wasm.call, ...count.func_idx_leb128,
      wasm.if, wasm.void,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.drop),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.br, 1,
      wasm.end,
    wasm.end,
    wasm.i32$const, ...sleb128i32(wasm.end),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.local$get, ...env,
    wasm.call, ...free.func_idx_leb128
  );
});

def_special_form("quote", function (_func) {
  const func = _func.param(wasm.i32),
        forms = _func.param(wasm.i32),
        env = _func.param(wasm.i32);
  _func.add_result(wasm.i32);
  _func.append_code(
    wasm.local$get, ...forms,
    wasm.call, ...first.func_idx_leb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...funcs.uleb128.emit_code_default
  );
});

funcs.build("emit_code_special_form",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (head, args, func, env) {
    const xpt = this.local(wasm.i32),
          hdl = this.local(wasm.i32);
    return [
      wasm.local$get, ...head,
      wasm.i32$const, ...sleb128i32(make_symbol("fn")),
      wasm.i32$eq,
      wasm.local$get, ...head,
// todo: set export with metadata instead
      wasm.i32$const, ...sleb128i32(make_symbol("export-fn")),
      wasm.i32$eq,
      wasm.local$tee, ...xpt,
      wasm.i32$or,
      wasm.if, wasm.i32,
        wasm.local$get, ...func,
        wasm.local$get, ...xpt,
        wasm.local$get, ...args,
        wasm.local$get, ...env,
        wasm.call, ...funcs.uleb128.comp_func,
      wasm.else,
        wasm.i32$const, ...sleb128i32(special_forms),
        wasm.local$get, ...head,
        wasm.i32$const, nil,
        wasm.call, ...get.func_idx_leb128,
        wasm.local$tee, ...hdl,
        wasm.if, wasm.i32,
          wasm.local$get, ...func,
          wasm.local$get, ...args,
          wasm.local$get, ...env,
          wasm.local$get, ...hdl,
          wasm.call, ...types.Function.fields.tbl_idx.leb128,
          wasm.call_indirect,
          ...sleb128i32(get_type_idx(3, 0, 0, wasm.i32)), 0,
        wasm.else,
          wasm.i32$const, 0,
        wasm.end,
      wasm.end
    ];
  }
);

funcs.build("quote_form",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (form, sym) {
    return [
      wasm.i32$const, 2,
      wasm.call, ...funcs.uleb128.refs_array_by_length,
      wasm.i32$const, 0,
      wasm.local$get, ...sym,
      wasm.call, ...funcs.uleb128.refs_array_set,
      wasm.i32$const, 1,
      wasm.local$get, ...form,
      wasm.call, ...funcs.uleb128.refs_array_set,
      wasm.call, ...funcs.uleb128.vector_seq_from_array,
    ];
  }
);

funcs.build("emit_code_num64",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (form, func, env) {
    const ns = this.local(wasm.i32),
          nm = this.local(wasm.i32),
          op = this.local(wasm.i32);
    return [
      wasm.local$get, ...form,
      wasm.call, ...first.func_idx_leb128,
      wasm.local$tee, ...op,
      wasm.call, ...types.Symbol.fields.namespace.leb128,
      wasm.local$tee, ...ns,
      wasm.call, ...types.String.predicate_leb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...ns,
        wasm.i32$const, ...sleb128i32(cached_string("i64")),
        wasm.call, ...funcs.uleb128.eq,
        wasm.local$get, ...ns,
        wasm.i32$const, ...sleb128i32(cached_string("f64")),
        wasm.call, ...funcs.uleb128.eq,
        wasm.i32$or,
        wasm.if, wasm.i32,
          wasm.loop, wasm.void,
            wasm.local$get, ...form,
            wasm.call, ...rest.func_idx_leb128,
            wasm.local$get, ...form,
            wasm.call, ...free.func_idx_leb128,
            wasm.local$tee, ...form,
            wasm.call, ...count.func_idx_leb128,
            wasm.if, wasm.void,
              wasm.local$get, ...form,
              wasm.call, ...first.func_idx_leb128,
              wasm.local$get, ...func,
              wasm.local$get, ...env,
              wasm.call, ...emit_code.func_idx_leb128,
              wasm.drop,
              wasm.br, 1,
            wasm.end,
          wasm.end,
          wasm.local$get, ...func,
          wasm.local$get, ...ns,
          wasm.call, ...store_string.func_idx_leb128,
          wasm.local$get, ...op,
          wasm.call, ...types.Symbol.fields.name.leb128,
          wasm.local$tee, ...nm,
          wasm.call, ...store_string.func_idx_leb128,
          wasm.call, ...get_op_code.func_idx_leb128,
          wasm.call, ...append_code.func_idx_leb128,
          wasm.local$get, ...nm,
          wasm.i32$const, ...sleb128i32(cached_string("eq")),
          wasm.call, ...funcs.uleb128.eq,
          wasm.if, wasm.void,
            wasm.local$get, ...func,
            wasm.i32$const, ...sleb128i32(wasm.i64$extend_i32_u),
            wasm.call, ...append_code.func_idx_leb128,
            wasm.drop,
          wasm.end,
        wasm.else,
          wasm.i32$const, 0,
        wasm.end,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  }
);

// todo: throw when no split
funcs.build("emit_js_func_call",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (head, args, func, env) {
    const split = this.local(wasm.i32),
          idx = this.local(wasm.i32);
    return [
      wasm.local$get, ...head,
      wasm.call, ...types.Symbol.fields.namespace.leb128,
      wasm.i32$const, ...sleb128i32(cached_string("js")),
      wasm.call, ...funcs.uleb128.eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...head,
        wasm.call, ...types.Symbol.fields.name.leb128,
        wasm.local$tee, ...head,
        wasm.i32$const, 0,
        wasm.local$get, ...head,
        wasm.i32$const, ...sleb128i32(".".codePointAt(0)),
        wasm.call, ...index_of_codepoint.func_idx_leb128,
        wasm.local$tee, ...split,
        wasm.call, ...funcs.uleb128.substring_until,
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.call, ...emit_code.func_idx_leb128,
        wasm.drop,
        wasm.local$get, ...head,
        wasm.local$get, ...split,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.call, ...funcs.uleb128.substring_to_end,
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.call, ...emit_code.func_idx_leb128,
        wasm.i32$const, ...sleb128i32(wasm.i32$const),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.local$get, ...args,
        wasm.call, ...count.func_idx_leb128,
        wasm.call, ...append_varuint32.func_idx_leb128,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.i32$const, ...funcs.uleb128.array_by_length,
        wasm.call, ...append_varuint32.func_idx_leb128,
        wasm.loop, wasm.void,
          wasm.local$get, ...args,
          wasm.call, ...count.func_idx_leb128,
          wasm.if, wasm.void,
            wasm.local$get, ...func,
            wasm.i32$const, ...sleb128i32(wasm.i32$const),
            wasm.call, ...append_code.func_idx_leb128,
            wasm.local$get, ...idx,
            wasm.call, ...append_varsint32.func_idx_leb128,
            wasm.drop,
            wasm.local$get, ...args,
            wasm.call, ...first.func_idx_leb128,
            wasm.local$get, ...func,
            wasm.local$get, ...env,
            wasm.call, ...emit_code.func_idx_leb128,
            wasm.i32$const, ...sleb128i32(wasm.call),
            wasm.call, ...append_code.func_idx_leb128,
            wasm.i32$const, ...funcs.uleb128.array_set_i32,
            wasm.call, ...append_varuint32.func_idx_leb128,
            wasm.drop,
            wasm.local$get, ...idx,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...idx,
            wasm.local$get, ...args,
            wasm.call, ...rest.func_idx_leb128,
            wasm.local$get, ...args,
            wasm.call, ...free.func_idx_leb128,
            wasm.local$set, ...args,
            wasm.br, 1,
          wasm.end,
        wasm.end,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.func_idx_leb128,
        wasm.i32$const, ...js_call.func_idx_leb128,
        wasm.call, ...append_varuint32.func_idx_leb128,
        wasm.drop,
        wasm.i32$const, 1,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  }
);

emit_code.implement(types.Seq, function (list, func, env) {
  const inner_env = this.local(wasm.i32),
        list_head = this.local(wasm.i32),
        func_record = this.local(wasm.i32),
        num_args = this.local(wasm.i32),
        args_list = this.local(wasm.i32),
        result = this.local(wasm.i32),
        curr_local = this.local(wasm.i32),
        revert_inner = this.local(wasm.i32),
        revert_inner_idx = this.local(wasm.i32);
  return [
    wasm.local$get, ...list,
    wasm.call, ...count.func_idx_leb128,
    wasm.if, wasm.void,
      wasm.local$get, ...list,
      wasm.call, ...first.func_idx_leb128,
      wasm.local$tee, ...list_head,
      wasm.local$get, ...list,
      wasm.call, ...rest.func_idx_leb128,
      wasm.local$tee, ...args_list,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...funcs.uleb128.emit_code_special_form,
      wasm.i32$eqz,
      wasm.if, wasm.void,
        wasm.local$get, ...list,
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.call, ...funcs.uleb128.emit_code_num64,
        wasm.i32$eqz,
        wasm.if, wasm.void,
          wasm.local$get, ...list_head,
          wasm.local$get, ...args_list,
          wasm.local$get, ...func,
          wasm.local$get, ...env,
          wasm.call, ...funcs.uleb128.emit_js_func_call,
          wasm.i32$eqz,
          wasm.if, wasm.void,
            wasm.local$get, ...func,
            wasm.local$get, ...env,
            wasm.local$get, ...list_head,
            wasm.call, ...funcs.uleb128.lookup_ref,
            wasm.local$get, ...args_list,
            wasm.i32$const, 0,
            wasm.call, ...funcs.uleb128.emit_func_call,
          wasm.end,
        wasm.end,
      wasm.end,
    wasm.else,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.local$get, ...list,
      wasm.call, ...append_varsint32.func_idx_leb128,
      wasm.drop,
    wasm.end,
    // wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...func
  ];
});

// todo: move to expand-form?
emit_code.implement(types.Vector, function (vec, func, env) {
  const idx = this.local(wasm.i32),
        cnt = this.local(wasm.i32),
        out = this.local(wasm.i32),
        runtime = this.local(wasm.i32),
        val = this.local(wasm.i32);
  return [
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.count.leb128,
    wasm.local$set, ...cnt,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.loop, wasm.void,
      wasm.local$get, ...idx,
      wasm.local$get, ...cnt,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...vec,
        wasm.local$get, ...idx,
        wasm.i32$const, nil,
        wasm.call, ...nth.func_idx_leb128,
        wasm.local$tee, ...val,
        wasm.call, ...types.Symbol.predicate_leb128,
        wasm.local$get, ...val,
        wasm.call, ...types.Seq.predicate_leb128,
        wasm.i32$or,
        wasm.local$get, ...runtime,
        wasm.i32$eqz,
        wasm.i32$and,
        wasm.if, wasm.void,
          wasm.local$get, ...func,
          wasm.local$get, ...cnt,
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.i32$const, ...sleb128i32(wasm.call),
          wasm.call, ...append_code.func_idx_leb128,
          wasm.i32$const, ...funcs.uleb128.refs_array_by_length,
          wasm.call, ...append_varuint32.func_idx_leb128,
          wasm.drop,
          wasm.i32$const, 1,
          wasm.local$set, ...runtime,
          wasm.i32$const, 0,
          wasm.local$set, ...idx,
        wasm.else,
          wasm.local$get, ...runtime,
          wasm.if, wasm.void,
            wasm.local$get, ...val,
            wasm.local$get, ...func,
            wasm.i32$const, ...sleb128i32(wasm.i32$const),
            wasm.call, ...append_code.func_idx_leb128,
            wasm.local$get, ...idx,
            wasm.call, ...append_varuint32.func_idx_leb128,
            wasm.local$get, ...env,
            wasm.call, ...emit_code.func_idx_leb128,
            wasm.i32$const, ...sleb128i32(wasm.call),
            wasm.call, ...append_code.func_idx_leb128,
            wasm.i32$const, ...funcs.uleb128.refs_array_set,
            wasm.call, ...append_varuint32.func_idx_leb128,
            wasm.drop,
          wasm.end,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...idx,
        wasm.end,
        wasm.br, 1,
      wasm.end,
    wasm.end,
    wasm.local$get, ...runtime,
    wasm.if, wasm.void,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...append_code.func_idx_leb128,
      wasm.i32$const, ...funcs.uleb128.vector_from_array,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.drop,
    wasm.else,
      wasm.local$get, ...func,
      wasm.local$get, ...vec,
      wasm.call, ...append_varuint32.func_idx_leb128,
      wasm.drop,
    wasm.end
  ];
});

/*-----------*\
|             |
| expand-form |
|             |
\*-----------*/

const expand_form = new_method("expand-form", 1, wasm.i32, function (form) {
  return [wasm.local$get, ...form];
});

/*------------*\
|              |
| syntax-quote |
|              |
\*------------*/

const syntax_quote = new_method("syntax-quote", 1, wasm.i32, function (form) {
  return [wasm.local$get, ...form];
});

syntax_quote.implement(types.Seq, function (seq) {
  const idx = this.local(wasm.i32),
        out = this.local(wasm.i32),
        tmp = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...first.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(make_symbol("unquote")),
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...seq,
      wasm.call, ...rest.func_idx_leb128,
      wasm.local$tee, ...out,
      wasm.call, ...first.func_idx_leb128,
      wasm.local$get, ...out,
      wasm.call, ...free.func_idx_leb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
      wasm.local$set, ...out,
      wasm.loop, wasm.void,
        wasm.local$get, ...seq,
        wasm.call, ...count.func_idx_leb128,
        wasm.if, wasm.void,
          wasm.i32$const, ...sleb128i32(empty_seq),
          wasm.i32$const, ...sleb128i32(make_symbol("seq-append")),
          wasm.call, ...funcs.uleb128.seq_append,
          wasm.local$tee, ...tmp,
          wasm.local$get, ...out,
          wasm.call, ...funcs.uleb128.seq_append,
          wasm.local$get, ...tmp,
          wasm.call, ...free.func_idx_leb128,
          wasm.local$tee, ...tmp,
          wasm.local$get, ...seq,
          wasm.call, ...first.func_idx_leb128,
          wasm.call, ...syntax_quote.func_idx_leb128,
          wasm.call, ...funcs.uleb128.seq_append,
          wasm.local$get, ...tmp,
          wasm.call, ...free.func_idx_leb128,
          wasm.local$set, ...out,
          wasm.local$get, ...seq,
          wasm.call, ...rest.func_idx_leb128,
          wasm.local$get, ...seq,
          wasm.call, ...free.func_idx_leb128,
          wasm.local$set, ...seq,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...out,
    wasm.end
  ];
});

// todo: namespace & gensym
syntax_quote.implement(types.Symbol, function (sym) {
  const idx = this.local(wasm.i32),
        out = this.local(wasm.i32);
  return [
    wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.i32$const, ...sleb128i32(make_symbol("symbol")),
    wasm.call, ...funcs.uleb128.seq_append,
    wasm.local$tee, ...out,
    wasm.local$get, ...sym,
    wasm.call, ...types.Symbol.fields.namespace.leb128,
    wasm.call, ...funcs.uleb128.seq_append,
    wasm.local$get, ...out,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$tee, ...out,
    wasm.local$get, ...sym,
    wasm.call, ...types.Symbol.fields.name.leb128,
    wasm.call, ...funcs.uleb128.seq_append,
    wasm.local$get, ...out,
    wasm.call, ...free.func_idx_leb128
  ];
});

/*------------*\
|              |
| compile-form |
|              |
\*------------*/

funcs.build("new_env",
  [], [wasm.i32], {},
  function (func) {
    const addr = this.local(wasm.i32),
          offset = this.local(wasm.i32),
          env = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(empty_hash_map),
      wasm.i32$const, ...sleb128i32(make_keyword("locals")),
      wasm.i32$const, 0,
      wasm.call, ...funcs.uleb128.array_by_length,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...types.Atom.constr.leb128,
      wasm.call, ...assoc.func_idx_leb128,
      wasm.local$tee, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("locals-to-free")),
      wasm.i32$const, 0,
      wasm.call, ...funcs.uleb128.array_by_length,
      wasm.call, ...inc_refs.func_idx_leb128,
      wasm.i32$const, 0,
      wasm.call, ...types.Atom.constr.leb128,
      wasm.call, ...assoc.func_idx_leb128,
      wasm.local$get, ...env,
      wasm.call, ...free.func_idx_leb128
    ];
  }
);

// todo: free here and in emit_code
compile_form.build(function (func) {
  const form = func.param(wasm.i32),
        out = func.local(wasm.i32),
        env = func.local(wasm.i32);
  func.add_result(wasm.i32);
  func.set_export("compile_form");
  func.append_code(
    wasm.local$get, ...form,
    wasm.call, ...expand_form.func_idx_leb128,
    wasm.call, ...start_func.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.i32$const, 4,
    wasm.call, ...funcs.uleb128.alloc,
    wasm.local$tee, ...out,
    wasm.call, ...append_varsint32.func_idx_leb128,
    wasm.call, ...funcs.uleb128.new_env,
    wasm.local$tee, ...env,
    wasm.call, ...emit_code.func_idx_leb128,
    wasm.i32$const, ...sleb128i32(wasm.i32$store),
    wasm.call, ...append_code.func_idx_leb128,
    wasm.i32$const, 2,
    wasm.call, ...append_varuint32.func_idx_leb128,
    wasm.i32$const, 0,
    wasm.call, ...append_varuint32.func_idx_leb128,
    wasm.call, ...end_func.func_idx_leb128,
    wasm.call, ...add_to_start_func.func_idx_leb128,
    wasm.local$get, ...env,
    wasm.call, ...free.func_idx_leb128,
// todo: why does this make no difference?
    //wasm.local$get, ...form,
    //wasm.call, ...free.func_idx_leb128,
// todo: emit_code should determine if double compilation needed
// (i.e. if form emited that needs to be compiled)
    wasm.call, ...compile.func_idx_leb128,
    wasm.call, ...compile.func_idx_leb128,
    wasm.local$get, ...out,
    wasm.i32$load, 2, 0,
    wasm.local$get, ...out,
    wasm.i32$const, 4,
    wasm.call, ...funcs.uleb128.free_mem,
  );
});

/*------------*\
|              |
| parsing text |
|              |
\*------------*/

function expand_switch (tgt, dft, ...clauses) {
  let out = dft,
      len = clauses.length;
  for (let i = 0; i < len; i += 2) {
    out = [
      wasm.local$get, ...tgt,
      ...clauses[len - i - 2],
      wasm.i32$eq,
      wasm.if, wasm.i32,
        ...clauses[len - i - 1],
      wasm.else,
        ...out,
      wasm.end
    ];
  }
  return out;
}

funcs.build("is_line_terminator",
  [wasm.i32], [wasm.i32], {},
  function (chr) {
    return [
      ...expand_switch(
        chr, [wasm.i32$const, 0],
        // https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-line-terminators
        // LINE FEED
        [wasm.i32$const, ...sleb128i32(0xa)], [wasm.i32$const, 2],
        // CARRIAGE RETURN
        [wasm.i32$const, ...sleb128i32(0xd)], [wasm.i32$const, 2],
        // LINE SEPARATOR
        [wasm.i32$const, ...sleb128i32(0x2028)], [wasm.i32$const, 2],
        // PARAGRAPH SEPARATOR
        [wasm.i32$const, ...sleb128i32(0x2029)], [wasm.i32$const, 2]
      )
    ];
  }
);

funcs.build("is_whitespace",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (chr, incl_line_term) {
    return [
      ...expand_switch(
        chr, [
          wasm.local$get, ...incl_line_term,
          wasm.if, wasm.i32,
            wasm.local$get, ...chr,
            wasm.call, ...funcs.uleb128.is_line_terminator,
          wasm.else,
            wasm.i32$const, 0,
          wasm.end
        ],
        // https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-white-space
        // CHARACTER TABULATION <TAB>
        [wasm.i32$const, 0x9], [wasm.i32$const, 1],
        // LINE TABULATION <VT>
        [wasm.i32$const, 0xb], [wasm.i32$const, 1],
        // FORM FEED <FF>
        [wasm.i32$const, 0xc], [wasm.i32$const, 1],
        // ZERO WIDTH NO-BREAK SPACE <ZWNBSP>
        [wasm.i32$const, ...sleb128i32(0xfeff)], [wasm.i32$const, 1],
        // https://util.unicode.org/UnicodeJsps/list-unicodeset.jsp?a=%5B:General_Category=Space_Separator:%5D
        // SPACE
        [wasm.i32$const, ...sleb128i32(0x20)], [wasm.i32$const, 1],
        // NO-BREAK SPACE
        [wasm.i32$const, ...sleb128i32(0xa0)], [wasm.i32$const, 1],
        // OGHAM SPACE MARK
        [wasm.i32$const, ...sleb128i32(0x1680)], [wasm.i32$const, 1],
        // EN QUAD
        [wasm.i32$const, ...sleb128i32(0x2000)], [wasm.i32$const, 1],
        // EM QUAD
        [wasm.i32$const, ...sleb128i32(0x2001)], [wasm.i32$const, 1],
        // EN SPACE
        [wasm.i32$const, ...sleb128i32(0x2002)], [wasm.i32$const, 1],
        // EM SPACE
        [wasm.i32$const, ...sleb128i32(0x2003)], [wasm.i32$const, 1],
        // THREE-PER-EM SPACE
        [wasm.i32$const, ...sleb128i32(0x2004)], [wasm.i32$const, 1],
        // FOUR-PER-EM SPACE
        [wasm.i32$const, ...sleb128i32(0x2005)], [wasm.i32$const, 1],
        // SIX-PER-EM SPACE
        [wasm.i32$const, ...sleb128i32(0x2006)], [wasm.i32$const, 1],
        // FIGURE SPACE
        [wasm.i32$const, ...sleb128i32(0x2007)], [wasm.i32$const, 1],
        // PUNCTUATION SPACE
        [wasm.i32$const, ...sleb128i32(0x2008)], [wasm.i32$const, 1],
        // THIN SPACE
        [wasm.i32$const, ...sleb128i32(0x2009)], [wasm.i32$const, 1],
        // HAIR SPACE
        [wasm.i32$const, ...sleb128i32(0x200A)], [wasm.i32$const, 1],
        // NARROW NO-BREAK SPACE
        [wasm.i32$const, ...sleb128i32(0x202F)], [wasm.i32$const, 1],
        // MEDIUM MATHEMATICAL SPACE
        [wasm.i32$const, ...sleb128i32(0x205F)], [wasm.i32$const, 1],
        // IDEOGRAPHIC SPACE
        [wasm.i32$const, ...sleb128i32(0x3000)], [wasm.i32$const, 1]
      )
    ];
  }
);

funcs.build("trim_left",
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (str, incl_newline) {
    const idx = this.local(wasm.i32),
          chr = this.local(wasm.i32);
    return [
      wasm.loop, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.get_codepoint,
        wasm.local$set, ...idx,
        wasm.local$tee, ...chr,
        wasm.if, wasm.void,
          wasm.local$get, ...chr,
          wasm.local$get, ...incl_newline,
          wasm.call, ...funcs.uleb128.is_whitespace,
          wasm.br_if, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$sub,
      wasm.local$tee, ...idx,
      wasm.call, ...funcs.uleb128.substring_to_end
    ];
  }
);

/*------------------------*\
|                          |
| parse & eval source code |
|                          |
\*------------------------*/

const read_form = func_builder();

funcs.build("validate_boundary",
  [wasm.i32, wasm.i32], [wasm.i32, wasm.i32], {},
  function (str, idx) {
    const chr = this.local(wasm.i32),
          after = this.local(wasm.i32),
          valid = this.local(wasm.i32);
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.call, ...funcs.uleb128.get_codepoint,
      wasm.local$set, ...after,
      wasm.local$tee, ...chr,
      wasm.i32$const, 1,
      wasm.call, ...funcs.uleb128.is_whitespace,
      wasm.if, wasm.i32,
        wasm.i32$const, 1,
      wasm.else,
        wasm.local$get, ...chr,
        wasm.i32$const, ...sleb128i32("]".codePointAt(0)),
        wasm.i32$eq,
        wasm.if, wasm.i32,
          wasm.i32$const, 1,
        wasm.else,
          wasm.local$get, ...chr,
          wasm.i32$const, ...sleb128i32(")".codePointAt(0)),
          wasm.i32$eq,
          wasm.if, wasm.i32,
            wasm.i32$const, 1,
          wasm.else,
            wasm.local$get, ...chr,
            wasm.i32$const, ...sleb128i32("}".codePointAt(0)),
            wasm.i32$eq,
            wasm.if, wasm.i32,
              wasm.i32$const, 1,
            wasm.else,
              wasm.i32$const, 0,
            wasm.end,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.if, wasm.void,
        wasm.i32$const, 1,
        wasm.local$set, ...valid,
      wasm.else,
        wasm.local$get, ...after,
        wasm.local$set, ...idx,
      wasm.end,
      wasm.local$get, ...valid,
      wasm.local$get, ...idx
    ];
  }
);

funcs.build("numeric_value_of_char",
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32, wasm.i64], {},
  function (chr, base, offset) {
    const num = this.local(wasm.i32),
          valid = this.local(wasm.i32);
    return [
      wasm.loop, wasm.void,
        wasm.local$get, ...chr,
        wasm.local$get, ...offset,
        wasm.i32$sub,
        wasm.local$tee, ...num,
        wasm.local$get, ...base,
        wasm.i32$lt_u,
        wasm.local$tee, ...valid,
        wasm.i32$eqz,
        wasm.if, wasm.void,
          wasm.local$get, ...base,
          wasm.i32$const, 10,
          wasm.i32$gt_u,
          wasm.local$get, ...chr,
          wasm.i32$const, ...sleb128i32("a".codePointAt(0)),
          wasm.i32$ge_u,
          wasm.i32$and,
          wasm.if, wasm.void,
            wasm.local$get, ...chr,
            wasm.i32$const, 10,
            wasm.i32$add,
            wasm.local$set, ...chr,
            wasm.i32$const, ...sleb128i32("a".codePointAt(0)),
            wasm.local$set, ...offset,
            wasm.br, 2,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.local$get, ...valid,
      wasm.local$get, ...num,
      wasm.i64$extend_i32_u
    ];
  }
);

funcs.build("parse_number",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno, has_sign) {
    const base = this.local(wasm.i64),
          chr = this.local(wasm.i32),
          digit = this.local(wasm.i64),
          num = this.local(wasm.i64),
          frc_div = this.local(wasm.f64),
          is_float = this.local(wasm.i32),
          exp = this.local(wasm.i64),
          is_exp = this.local(wasm.i32),
          tmp = this.local(wasm.i32);
    return [
      wasm.f64$const, 0, 0, 0, 0, 0, 0, 0xf0, 0x3f, // 1
      wasm.local$set, ...frc_div,
      wasm.i64$const, 10,
      wasm.local$set, ...base,
      wasm.local$get, ...has_sign,
      wasm.if, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.get_codepoint,
        wasm.local$set, ...idx,
        wasm.i32$const, ...sleb128i32(45),
        wasm.i32$eq,
        wasm.local$set, ...has_sign,
      wasm.end,
      wasm.loop, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.local$tee, ...tmp,
        wasm.call, ...funcs.uleb128.get_codepoint,
        wasm.local$set, ...idx,
        wasm.local$tee, ...chr,
        wasm.local$get, ...base,
        wasm.i32$wrap_i64,
        wasm.i32$const, ...sleb128i32("0".codePointAt(0)),
        wasm.call, ...funcs.uleb128.numeric_value_of_char,
        wasm.local$set, ...digit,
        wasm.if, wasm.void,
          wasm.local$get, ...is_exp,
          wasm.if, wasm.void,
            wasm.local$get, ...exp,
            wasm.i64$const, 10,
            wasm.i64$mul,
            wasm.local$get, ...digit,
            wasm.i64$add,
            wasm.local$set, ...exp,
            wasm.br, 2,
          wasm.else,
            wasm.local$get, ...is_float,
            wasm.if, wasm.void,
              wasm.local$get, ...frc_div,
              wasm.f64$const, 0, 0, 0, 0, 0, 0, 0x24, 0x40, // 10
              wasm.f64$mul,
              wasm.local$set, ...frc_div,
            wasm.end,
            wasm.local$get, ...num,
            wasm.local$get, ...base,
            wasm.i64$mul,
            wasm.local$get, ...digit,
            wasm.i64$add,
            wasm.local$set, ...num,
            wasm.br, 2,
          wasm.end,
        wasm.else,
          wasm.local$get, ...chr,
          wasm.i32$const, ...sleb128i32("e".codePointAt(0)),
          wasm.i32$eq,
          wasm.local$get, ...is_exp,
          wasm.i32$eqz,
          wasm.i32$and,
          wasm.if, wasm.void,
            wasm.i32$const, 1,
            wasm.local$set, ...is_float,
            wasm.i32$const, 1,
            wasm.local$set, ...is_exp,
            wasm.br, 2,
          wasm.else,
            wasm.local$get, ...base,
            wasm.i64$const, 10,
            wasm.i64$eq,
            wasm.if, wasm.void,
              wasm.local$get, ...chr,
              wasm.i32$const, ...sleb128i32(".".codePointAt(0)),
              wasm.i32$eq,
              wasm.local$get, ...is_float,
              wasm.i32$eqz,
              wasm.i32$and,
              wasm.if, wasm.void,
                wasm.i32$const, 1,
                wasm.local$set, ...is_float,
                wasm.br, 4,
              wasm.else,
                wasm.local$get, ...num,
                wasm.i64$eqz,
                wasm.if, wasm.void,
                  wasm.local$get, ...chr,
                  wasm.i32$const, ...sleb128i32("x".codePointAt(0)),
                  wasm.i32$eq,
                  wasm.if, wasm.void,
                    wasm.i64$const, 16,
                    wasm.local$set, ...base,
                    wasm.br, 6,
                  wasm.else,
                    wasm.local$get, ...chr,
                    wasm.i32$const, ...sleb128i32("o".codePointAt(0)),
                    wasm.i32$eq,
                    wasm.if, wasm.void,
                      wasm.i64$const, 8,
                      wasm.local$set, ...base,
                      wasm.br, 7,
                    wasm.else,
                      wasm.local$get, ...chr,
                      wasm.i32$const, ...sleb128i32("b".codePointAt(0)),
                      wasm.i32$eq,
                      wasm.if, wasm.void,
                        wasm.i64$const, 2,
                        wasm.local$set, ...base,
                        wasm.br, 8,
                      wasm.end,
                    wasm.end,
                  wasm.end,
                wasm.end,
              wasm.end,
            wasm.end,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.local$get, ...has_sign,
      wasm.if, wasm.void,
        wasm.i64$const, 0,
        wasm.local$get, ...num,
        wasm.i64$sub,
        wasm.local$set, ...num,
      wasm.end,
      wasm.local$get, ...is_float,
      wasm.if, wasm.i32,
        wasm.local$get, ...num,
        wasm.f64$convert_i64_s,
        wasm.f64$const, 0, 0, 0, 0, 0, 0, 0x24, 0x40, // 10
        wasm.local$get, ...exp,
        wasm.call, ...funcs.uleb128.pow,
        wasm.f64$mul,
        wasm.local$get, ...frc_div,
        wasm.f64$div,
        wasm.call, ...types.Float.constr.leb128,
      wasm.else,
        wasm.local$get, ...num,
        wasm.call, ...types.Int.constr.leb128,
      wasm.end,
      wasm.local$get, ...tmp,
      wasm.local$get, ...lineno,
    ];
  }
);

const literal_tagged_data = new_method(null, 1, wasm.i32);

literal_tagged_data.implement(types.Int, function (int) {
  return [
    wasm.i32$const, 2,
    wasm.call, ...funcs.uleb128.refs_array_by_length,
    wasm.i32$const, 0,
    wasm.i32$const, ...sleb128i32(make_symbol(nil, "Int$value")),
    wasm.call, ...funcs.uleb128.refs_array_set,
    wasm.i32$const, 1,
    wasm.local$get, ...int,
    wasm.call, ...funcs.uleb128.refs_array_set,
    wasm.call, ...funcs.uleb128.vector_seq_from_array
  ];
});

literal_tagged_data.implement(types.Float, function (flt) {
  return [
    wasm.i32$const, 2,
    wasm.call, ...funcs.uleb128.refs_array_by_length,
    wasm.i32$const, 0,
    wasm.i32$const, ...sleb128i32(make_symbol(nil, "Float$value")),
    wasm.call, ...funcs.uleb128.refs_array_set,
    wasm.i32$const, 1,
    wasm.local$get, ...flt,
    wasm.call, ...funcs.uleb128.refs_array_set,
    wasm.call, ...funcs.uleb128.vector_seq_from_array
  ];
});

literal_tagged_data.implement(types.Vector, function (vec) {
  const arr = this.local(wasm.i32),
        len = this.local(wasm.i32),
        idx = this.local(wasm.i32),
        val = this.local(wasm.i32),
        out = this.local(wasm.i32);
  return [
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.tail.leb128,
    wasm.call, ...types.RefsArray.fields.arr.leb128,
    wasm.local$tee, ...arr,
    wasm.call, ...types.Array.fields.length.leb128,
    wasm.local$tee, ...len,
    wasm.i32$const, 2,
    wasm.i32$shl,
    wasm.call, ...funcs.uleb128.array_by_length,
    wasm.local$set, ...out,
    wasm.loop, wasm.void,
      wasm.local$get, ...idx,
      wasm.local$get, ...len,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.array_get_i32,
        wasm.local$tee, ...val,
        wasm.call, ...types.Int.predicate_leb128,
        wasm.if, wasm.void,
          wasm.local$get, ...out,
          wasm.local$get, ...idx,
          wasm.local$get, ...val,
          wasm.call, ...types.Int.fields.value.leb128,
          wasm.call, ...funcs.uleb128.array_set_i64,
          wasm.drop,
        wasm.else,
          wasm.local$get, ...val,
          wasm.call, ...types.Float.predicate_leb128,
          wasm.if, wasm.void,
            wasm.local$get, ...out,
            wasm.local$get, ...idx,
            wasm.local$get, ...val,
            wasm.call, ...types.Float.fields.value.leb128,
            wasm.call, ...funcs.uleb128.array_set_f64,
            wasm.drop,
          wasm.else,
            wasm.i32$const, 0,
            wasm.i32$const, ...sleb128i32(cached_string("literal-tagged-data#vector")),
            wasm.call, ...types.Exception.constr.leb128,
            wasm.throw, 0,
          wasm.end,
        wasm.end,
        wasm.local$get, ...idx,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.local$set, ...idx,
        wasm.br, 1,
      wasm.end,
    wasm.end,
    wasm.local$get, ...vec,
    wasm.call, ...free.func_idx_leb128,
    wasm.local$get, ...out
  ];
});

funcs.build("parse_tagged_data",
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    const tag = this.local(wasm.i32);
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$tee, ...idx,
      wasm.local$get, ...lineno,
      wasm.call, ...read_form.func_idx_leb128,
      wasm.local$set, ...lineno,
      wasm.local$set, ...idx,
      wasm.local$tee, ...tag,
      wasm.call, ...types.Symbol.predicate_leb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...tag,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.local$get, ...lineno,
        wasm.call, ...read_form.func_idx_leb128,
        wasm.local$set, ...lineno,
        wasm.local$set, ...idx,
        wasm.call, ...types.TaggedData.constr.leb128,
      wasm.else,
        wasm.local$get, ...tag,
        wasm.call, ...literal_tagged_data.func_idx_leb128,
      wasm.end,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

function switch_string_match (str, idx, match_idx, ...clauses) {
  const clen = clauses.length;
  let out = [wasm.i32$const, 0];
  for (let c = 0; c < clen; c += 2) {
    const strs = clauses[clen - c - 2],
          len = strs.length;
    let inner_out = [wasm.i32$const, 0];
    for (let i = 0; i < len; i++) {
      let cmpr = strs[len - i - 1];
      if (typeof cmpr === "number") cmpr = String.fromCodePoint(cmpr);
      cmpr = cached_string(cmpr);
      inner_out = [
        wasm.local$get, ...str,
        wasm.i32$const, ...sleb128i32(cmpr),
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.string_matches_from,
        wasm.if, wasm.i32,
          wasm.local$get, ...idx,
          wasm.i32$const, ...sleb128i32(cmpr),
          wasm.call, ...string_length.func_idx_leb128,
          wasm.i32$add,
          wasm.local$tee, ...match_idx,
        wasm.else,
          ...inner_out,
        wasm.end,
      ];
    }
    out = [
      ...inner_out,
      wasm.if, wasm.i32,
        ...clauses[clen - c - 1],
      wasm.else,
        ...out,
      wasm.end
    ]
  }
  return out;
}

function range (start, end) {
  const out = [start];
  while (start <= end) out.push(start++);
  return out;
}

const symbol_start_chars = [
  "!", "$", "%", "&", "*", "+", "-", ".", "_", "|",
  ...range(48, 57), ...range(60, 63), ...range(65, 90),
  ...range(97, 122), ...range(192, 214), ...range(216, 246),
  ...range(248, 255)
];

funcs.build("parse_symbol",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno, iskw) {
    const org_idx = this.local(wasm.i32),
          match_idx = this.local(wasm.i32),
          chr = this.local(wasm.i32),
          ns = this.local(wasm.i32),
          nm_start = this.local(wasm.i32),
          nm = this.local(wasm.i32),
          autoresolve = this.local(wasm.i32),
          out = this.local(wasm.i32);
    return [
      wasm.local$get, ...idx,
      wasm.local$get, ...iskw,
      wasm.i32$add,
      wasm.local$tee, ...idx,
      wasm.local$tee, ...org_idx,
      wasm.local$set, ...nm_start,
      wasm.loop, wasm.void,
        ...switch_string_match(str, idx, match_idx,
          [":"],
          [
            wasm.local$get, ...iskw,
            wasm.local$get, ...org_idx,
            wasm.local$get, ...idx,
            wasm.i32$eq,
            wasm.i32$and,
            wasm.if, wasm.void,
              wasm.i32$const, 1,
              wasm.local$set, ...autoresolve,
              wasm.local$get, ...match_idx,
              wasm.local$tee, ...org_idx,
              wasm.local$set, ...nm_start,
            wasm.end,
            wasm.i32$const, 1
          ],
          ["#", "'", ...symbol_start_chars],
          [wasm.i32$const, 1],
          ["/"],
          [
            wasm.local$get, ...str,
            wasm.local$get, ...org_idx,
            wasm.local$get, ...idx,
            wasm.call, ...funcs.uleb128.substring_until,
            wasm.local$set, ...ns,
            wasm.local$get, ...match_idx,
            wasm.local$tee, ...nm_start,
          ]
        ),
        wasm.if, wasm.void,
  	wasm.local$get, ...match_idx,
          wasm.local$set, ...idx,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...str,
      wasm.local$get, ...nm_start,
      wasm.local$get, ...idx,
      wasm.call, ...funcs.uleb128.substring_until,
      wasm.local$set, ...nm,
      wasm.local$get, ...iskw,
      wasm.if, wasm.i32,
        wasm.local$get, ...ns,
        wasm.local$get, ...nm,
        wasm.call, ...funcs.uleb128.keyword,
      wasm.else,
        wasm.local$get, ...ns,
        wasm.i32$eqz,
        wasm.if, wasm.i32,
          wasm.local$get, ...nm,
          wasm.i32$const, ...sleb128i32(cached_string("nil")),
          wasm.call, ...funcs.uleb128.eq,
          wasm.if, wasm.i32,
            wasm.i32$const, nil,
            wasm.local$set, ...out,
            wasm.i32$const, 1,
          wasm.else,
            wasm.local$get, ...nm,
            wasm.i32$const, ...sleb128i32(cached_string("true")),
            wasm.call, ...funcs.uleb128.eq,
            wasm.if, wasm.i32,
              wasm.i32$const, ...sleb128i32(comp_true),
              wasm.local$set, ...out,
              wasm.i32$const, 1,
            wasm.else,
              wasm.local$get, ...nm,
              wasm.i32$const, ...sleb128i32(cached_string("false")),
              wasm.call, ...funcs.uleb128.eq,
              wasm.if, wasm.i32,
                wasm.i32$const, ...sleb128i32(comp_false),
                wasm.local$set, ...out,
                wasm.i32$const, 1,
              wasm.else,
                wasm.i32$const, 0,
              wasm.end,
            wasm.end,
          wasm.end,
        wasm.else,
          wasm.i32$const, 0,
        wasm.end,
        wasm.if, wasm.i32,
          wasm.local$get, ...out,
        wasm.else,
          wasm.local$get, ...ns,
          wasm.local$get, ...nm,
          wasm.call, ...funcs.uleb128.symbol,
        wasm.end,
      wasm.end,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

funcs.build("parse_coll",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno, delim) {
    const coll = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(empty_seq),
      wasm.local$set, ...coll,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$set, ...idx,
      wasm.loop, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.get_codepoint,
        wasm.drop,
        wasm.local$get, ...delim,
        wasm.i32$ne,
        wasm.if, wasm.void,
          wasm.local$get, ...coll,
          wasm.local$get, ...coll,
          wasm.local$get, ...str,
          wasm.local$get, ...idx,
          wasm.local$get, ...lineno,
          wasm.call, ...read_form.func_idx_leb128,
          wasm.local$set, ...lineno,
          wasm.local$set, ...idx,
          wasm.call, ...funcs.uleb128.seq_append,
          wasm.local$set, ...coll,
          wasm.call, ...free.func_idx_leb128,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...coll,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$get, ...lineno
    ];
  }
);

funcs.build("parse_list",
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno,
      wasm.i32$const, ...sleb128i32(")".codePointAt(0)),
      wasm.call, ...funcs.uleb128.parse_coll
    ];
  }
);

funcs.build("parse_vector",
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    const seq = this.local(wasm.i32),
          vec = this.local(wasm.i32);
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno,
      wasm.i32$const, ...sleb128i32("]".codePointAt(0)),
      wasm.call, ...funcs.uleb128.parse_coll,
      wasm.local$set, ...lineno,
      wasm.local$set, ...idx,
      wasm.local$tee, ...seq,
      wasm.call, ...types.Seq.fields.root.leb128,
      wasm.local$tee, ...vec,
      wasm.if, wasm.i32,
        wasm.local$get, ...vec,
        wasm.call, ...types.VectorSeq.fields.vec.leb128,
        wasm.call, ...inc_refs.func_idx_leb128,
      wasm.else,
        wasm.i32$const, ...sleb128i32(empty_vector),
      wasm.end,
      wasm.local$get, ...seq,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

funcs.build("parse_map",
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    const seq = this.local(wasm.i32),
          cnt = this.local(wasm.i32),
          n = this.local(wasm.i32),
          map = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(empty_hash_map),
      wasm.local$set, ...map,
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno,
      wasm.i32$const, ...sleb128i32("}".codePointAt(0)),
      wasm.call, ...funcs.uleb128.parse_coll,
      wasm.local$set, ...lineno,
      wasm.local$set, ...idx,
      wasm.local$tee, ...seq,
      wasm.call, ...count.func_idx_leb128,
      wasm.local$set, ...cnt,
      wasm.loop, wasm.void,
        wasm.local$get, ...n,
        wasm.local$get, ...cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...map,
          wasm.local$get, ...seq,
          wasm.local$get, ...n,
          wasm.i32$const, nil,
          wasm.call, ...nth.func_idx_leb128,
          wasm.local$get, ...seq,
          wasm.local$get, ...n,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.i32$const, nil,
          wasm.call, ...nth.func_idx_leb128,
          wasm.call, ...assoc.func_idx_leb128,
          wasm.local$get, ...map,
          wasm.call, ...free.func_idx_leb128,
          wasm.local$set, ...map,
          wasm.local$get, ...n,
          wasm.i32$const, 2,
          wasm.i32$add,
          wasm.local$set, ...n,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...seq,
      wasm.call, ...free.func_idx_leb128,
      wasm.local$get, ...map,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

funcs.build("parse_syntax_quote",
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    const out = this.local(wasm.i32);
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$get, ...lineno,
      wasm.call, ...read_form.func_idx_leb128,
      wasm.local$set, ...lineno,
      wasm.local$set, ...idx,
      wasm.call, ...syntax_quote.func_idx_leb128,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

funcs.build("parse_quote",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno, sym) {
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$get, ...lineno,
      wasm.call, ...read_form.func_idx_leb128,
      wasm.local$set, ...lineno,
      wasm.local$set, ...idx,
      wasm.local$get, ...sym,
      wasm.call, ...funcs.uleb128.quote_form,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

funcs.build("parse_comment",
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    return [
      wasm.loop, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.get_codepoint,
        wasm.local$set, ...idx,
        wasm.i32$const, "\n".codePointAt(0),
        wasm.i32$ne,
        wasm.br_if, 0,
      wasm.end,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno,
      wasm.i32$const, 1,
      wasm.i32$add
    ];
  }
);

funcs.build("parse_string",
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    const out = this.local(wasm.i32),
          segment = this.local(wasm.i32),
          start = this.local(wasm.i32),
          chr = this.local(wasm.i32);
    return [
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$tee, ...idx,
      wasm.local$set, ...start,
      wasm.loop, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.get_codepoint,
        wasm.local$set, ...idx,
        wasm.local$tee, ...chr,
        wasm.i32$const, ...sleb128i32('"'.codePointAt(0)),
        wasm.i32$ne,
        wasm.if, wasm.void,
          wasm.local$get, ...chr,
          wasm.i32$const, ...sleb128i32("\\".codePointAt(0)),
          wasm.i32$eq,
          wasm.if, wasm.void,
            wasm.local$get, ...str,
            wasm.local$get, ...start,
            wasm.local$get, ...idx,
            wasm.i32$const, 1,
            wasm.i32$sub,
            wasm.call, ...funcs.uleb128.substring_until,
            wasm.local$set, ...segment,
            wasm.local$get, ...out,
            wasm.if, wasm.i32,
              wasm.local$get, ...out,
              wasm.local$get, ...segment,
              wasm.call, ...funcs.uleb128.concat_str,
              wasm.local$get, ...out,
              wasm.call, ...free.func_idx_leb128,
              wasm.local$get, ...segment,
              wasm.call, ...free.func_idx_leb128,
            wasm.else,
              wasm.local$get, ...segment,
            wasm.end,
            wasm.local$set, ...out,
            wasm.local$get, ...idx,
            wasm.local$tee, ...start,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...idx,
          wasm.else,
            wasm.local$get, ...chr,
            wasm.i32$const, ...sleb128i32("\n".codePointAt(0)),
            wasm.i32$eq,
            wasm.if, wasm.void,
              wasm.local$get, ...lineno,
              wasm.i32$const, 1,
              wasm.i32$add,
              wasm.local$set, ...lineno,
            wasm.end,
          wasm.end,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...str,
      wasm.local$get, ...start,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$sub,
      wasm.call, ...funcs.uleb128.substring_until,
      wasm.local$set, ...segment,
      wasm.local$get, ...out,
      wasm.if, wasm.i32,
        wasm.local$get, ...out,
        wasm.local$get, ...segment,
        wasm.call, ...funcs.uleb128.concat_str,
        wasm.local$get, ...out,
        wasm.call, ...free.func_idx_leb128,
        wasm.local$get, ...segment,
        wasm.call, ...free.func_idx_leb128,
      wasm.else,
        wasm.local$get, ...segment,
      wasm.end,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

read_form.build(function (func) {
  const str = func.param(wasm.i32),
        idx = func.param(wasm.i32),
        lineno = func.param(wasm.i32),
        org_idx = func.local(wasm.i32),
        match_idx = func.local(wasm.i32),
        out = func.local(wasm.i32),
        wts = func.local(wasm.i32),
        len = func.local(wasm.i32),
        chr = func.local(wasm.i32),
        tmp = func.local(wasm.i32);
  func.add_result(wasm.i32, wasm.i32, wasm.i32);
  func.append_code(
    wasm.local$get, ...idx,
    wasm.local$set, ...org_idx,
    wasm.local$get, ...str,
    wasm.call, ...string_length.func_idx_leb128,
    wasm.local$set, ...len,
    wasm.loop, wasm.void,
      wasm.local$get, ...idx,
      wasm.local$get, ...len,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...funcs.uleb128.get_codepoint,
        wasm.local$set, ...tmp,
        wasm.local$tee, ...chr,
        wasm.i32$const, 1,
        wasm.call, ...funcs.uleb128.is_whitespace,
        wasm.local$tee, ...wts,
        wasm.if, wasm.i32,
          wasm.local$get, ...tmp,
          wasm.local$set, ...idx,
          wasm.local$get, ...wts,
          wasm.i32$const, 2,
          wasm.i32$eq,
          wasm.if, wasm.void,
            wasm.local$get, ...lineno,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...lineno,
          wasm.end,
          wasm.i32$const, 1,
        wasm.else,
          wasm.local$get, ...chr,
          wasm.i32$const, ...sleb128i32(";".codePointAt(0)),
          wasm.i32$eq,
          wasm.if, wasm.i32,
            wasm.local$get, ...str,
            wasm.local$get, ...tmp,
            wasm.local$get, ...lineno,
            wasm.call, ...funcs.uleb128.parse_comment,
            wasm.local$set, ...lineno,
            wasm.local$set, ...idx,
            wasm.i32$const, 1,
          wasm.else,
            wasm.i32$const, 0,
          wasm.end,
        wasm.end,
        wasm.if, wasm.void,
          wasm.br, 2,
        wasm.else,
          ...switch_string_match(str, idx, match_idx,
            [
              "-0", "-1", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9",
              "+0", "+1", "+2", "+3", "+4", "+5", "+6", "+7", "+8", "+9"
            ],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, 1,
              wasm.call, ...funcs.uleb128.parse_number,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx,
            ],
            ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9",],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, 0,
              wasm.call, ...funcs.uleb128.parse_number,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx,
            ],
            ['"'],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...funcs.uleb128.parse_string,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx,
            ],
            [":"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, 1,
              wasm.call, ...funcs.uleb128.parse_symbol,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx,
            ],
            symbol_start_chars,
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, 0,
              wasm.call, ...funcs.uleb128.parse_symbol,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx,
            ],
            ["("],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...funcs.uleb128.parse_list,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["["],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...funcs.uleb128.parse_vector,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["{"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...funcs.uleb128.parse_map,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["#"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...funcs.uleb128.parse_tagged_data,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["'"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, ...sleb128i32(make_symbol("quote")),
              wasm.call, ...funcs.uleb128.parse_quote,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["`"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...funcs.uleb128.parse_syntax_quote,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["~"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, ...sleb128i32(make_symbol("unquote")),
              wasm.call, ...funcs.uleb128.parse_quote,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
          ),
          wasm.local$get, ...str,
          wasm.local$get, ...idx,
          wasm.call, ...funcs.uleb128.validate_boundary,
          wasm.local$set, ...idx,
          wasm.i32$eqz,
          wasm.if, wasm.void,
            wasm.local$get, ...str,
            wasm.i32$const, ...sleb128i32(cached_string("[syntax error] invalid or unexpected token: ")),
            wasm.local$get, ...str,
            wasm.local$get, ...org_idx,
            wasm.local$get, ...idx,
            wasm.call, ...funcs.uleb128.substring_until,
            wasm.call, ...funcs.uleb128.concat_str,
            wasm.throw, 0,
          wasm.end,
          wasm.local$set, ...out,
        wasm.end,
      wasm.end,
    wasm.end,
    wasm.local$get, ...out,
    wasm.local$get, ...idx,
    wasm.local$get, ...lineno
  );
});

funcs.build("eval_stream",
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], { export: true },
  function (str, interpret, idx, lineno) {
    const form = this.local(wasm.i32);
    return [
      wasm.local$get, ...idx,
      wasm.local$get, ...str,
      wasm.call, ...string_length.func_idx_leb128,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        // wasm.try, wasm.void,
          wasm.local$get, ...str,
          wasm.local$get, ...idx,
          wasm.local$get, ...lineno,
          wasm.call, ...read_form.func_idx_leb128,
          wasm.local$set, ...lineno,
          wasm.local$set, ...idx,
          wasm.local$set, ...form,
          wasm.local$get, ...interpret,
          wasm.if, wasm.void,
            wasm.local$get, ...form,
            wasm.call, ...compile_form.func_idx_leb128,
            wasm.call, ...free.func_idx_leb128,
          wasm.end,
        // wasm.catch_all,
        //   wasm.local$get, ...lineno,
        //   wasm.call, ...print_lineno.func_idx_leb128,
        //   wasm.i32$const, def_exception("caught error"),
        //   wasm.i32$const, 0,
        //   wasm.throw, 0,
        // wasm.end,
      wasm.end,
      wasm.local$get, ...form,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

cached_strings = {};

// END COMP

// !!! package cut

console.timeEnd("all");
console.time("core");

// thread_port = comp.alloc(8);

// todo: this is changing address 0 (nil)

// if (!main_env.is_main) {
//   const tgt = (new DataView(memory.buffer)).getUint32(main_env.thread_port, true);
//   // comp.add_watch(tgt);
// } else {
//   comp.watch(comp.Atom(nil), 3);
// }

// console.log(to_js(eval_string(`
// (def 'add (func _ (x y) (Int/new (i64/add (Int/value x) (Int/value y)))))
// (add 5 7)
// `)));

//const message_listener = spawn_thread(`
//const node_worker = require('node:worker_threads');
//node_worker.parentPort.on("message", function (mem) {
//  (function doWait (init) {
//    const buf = new Int32Array(mem.buffer);
//    Atomics.store(buf, ${(thread_port / 4) + 1}, 0);
//    Atomics.notify(buf, ${(thread_port / 4) + 1});
//    Atomics.wait(buf, ${thread_port / 4}, 0);
//    const new_val = Atomics.load(buf, ${thread_port / 4});
//    Atomics.store(buf, ${thread_port / 4}, 0);
//    node_worker.parentPort.postMessage(new_val + " " + ${thread_port});
//    doWait(new_val);
//  })(0);
//});
//`, { eval: true });

// start_thread();

function eval_file (f, interpret) {
  const fd = fs.openSync(f, "r"),
        file = comp.File(fd),
        len = fs.fstatSync(fd).size,
        a32 = new Uint32Array(parsed_forms);
  let idx = 0,
      lineno = 0,
      form = 0,
      a_idx = 0,
      buf_len = 0;
  while (idx < len) {
	  //console.log(comp.Function$func_num(expand_form.main_func));
    [form, idx, lineno] = comp.eval_stream(file, interpret, idx, lineno);
    // no need to store nil
    if (form) {
      parsed_forms.resize(buf_len += 4);
      a32[a_idx++] = form;
    }
  }
  comp.free(file);
}

// if the file is not compiled, only need compile() once
// if it's compiled and has a start_section (i.e. was parsed)
// then we need to call compile() here to initialize comp
// before compiling again with start_func
if (!module_len || had_start_section) compile();

if (typeof funcs !== "undefined") {
  while (funcs.comp.length) {
    let [nm, ...rest] = funcs.comp.pop();
    comp.store_comp_func(make_symbol(nm), ...rest);
  }
}

// if file was compiled or parsed, we need to initialize
// memory and (if parsed) call start_func
try {
  if (module_len) compile(precompiled);

  if (parsed_forms.byteLength) {
    const parsed32 = new Uint32Array(parsed_forms);
    for (let i = 0; i < parsed32.length; i++) {
      comp.compile_form(parsed32[i]);
    }
  }

  if (!main_env.is_browser) {
    if (argv.compile) {
      if (argv.compile[0]) eval_file(argv.compile[0], 1);
      fs.writeFile("blah.js", build_package(), () => null);
    } else if (argv.parse) {
      eval_file(argv.parse[0], 0);
      fs.writeFile("blah.js", build_package(), () => null);
    } else if (argv.interpret) {
      eval_file(argv.interpret[0], 1);
    }
  }
} catch (e) {
  if (e instanceof WebAssembly.Exception && e.is(exception_tag)) {
    const exc = e.getArg(exception_tag, 0);
    console.log(comp_string_to_js(comp.Exception$msg(exc)));
    return;
  }
  throw(e);
}

console.timeEnd("core");

}


"use strict";

// todo: track line/char number, improve error messaging/stack trace
// todo: better JS api (e.g. importing/exporting objects/methods)
// todo: Infinity & NaN
// todo: in worker threads, import should only add to import object
// todo: use SIMD for faster string/array comparison?
// todo: ensure all array operations check bounds
// todo: check if safe_add_i32 should be used more
// todo: check if should be using more atomic ops
// todo: make field_setters thread safe?
// todo: review all values created here (e.g. cached_string()) and consolidate/free
// todo: should String have an array or just a memory block?
// todo: review what's not needed in a compiled file
// todo: handle String/File encodings other than UTF8
// todo: avoid freeing static globals with inc_refs instead of checking count
// todo: store comp default function in Method so it can be partialed/store local scope
// todo: change type_num to i16, local_free to i8, leave i8 empty before refs
// todo: using append_varsint32 vs append_varuint32 in all the right places?
// todo: make callable as a library (export init)
// todo: store special characters of string to make escaping faster
// todo: select features to include in compiled file (reading files, interpreting code, etc)
// todo: allow setting initial & max memory pages
// todo: direct data ops on file (change memory ops to function calls)
// todo: move free to thread
// todo: number array is not comp object - no mem mgmt?

(function init (
  ref_table,
  next_ref_address,
  module_code,
  module_len,
  module_off,
  start_funcs_len,
  mem_len
) {
  const is_browser = this === this.window;
  if (is_browser) {
  
  } else {
    const argv = {
            compile: null,
            files: [],
            init_pages: 1,
            max_pages: 65536
          },
          workers = require('node:worker_threads');
    for (let i = 2, last_key; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (arg.startsWith("--")) {
        last_key = arg.replace("--", "");
      } else {
        if (!last_key) last_key = "files";
        if (argv[last_key] instanceof Array) {
          argv[last_key].push(arg);
        } else if (argv[last_key] instanceof Number) {
          argv[last_key] = parseInt(arg);
        } else {
          argv[last_key] = arg;
        }
      }
    }
    function new_worker (pkg) {
      return new workers.Worker(pkg, { eval: true });
    }
    if (workers.isMainThread) {
      build_comp(
        new_worker,
        init,
        { is_browser: false, is_main: true },
        argv,
        global,
        ref_table,
        next_ref_address,
        module_code,
        module_len,
        module_off,
        start_funcs_len,
        mem_len
      );
    } else {
      workers.parentPort.on("message", function (env) {
        build_comp(
          new_worker,
          init,
          env,
          argv,
          global,
          ref_table,
          next_ref_address,
          module_code
        );
      });
    }
  }
}).call(this, [null]);

function build_comp (
  new_worker,
  init,
  main_env,
  argv,
  js_imports,
  ref_table,
  next_ref_address,
  module_code,
  module_len,
  module_off,
  start_funcs_len,
  mem_len
) {

let in_package = false;

begin_package();

const fs = require("fs"),
      possible_exports = module_len ? null : {},
      start_funcs_buf = start_funcs_len ? new ArrayBuffer(start_funcs_len) : [];

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
    num >>>= 7;
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

// todo: how much of this is needed in compiled file?
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
  "i32$trunc_f64_s":		0xaa,
  "i32$trunc_f64_u":		0xab,
  "i64$extend_i32_s":		0xac,
  "i64$extend_i32_u":		0xad,
  "i64$trunc_f64_s":		0xb0,
  "i64$trunc_f64_u":		0xb1,
  "f64$convert_i32_s":		0xb7,
  "f64$convert_i32_u":		0xb8,
  "f64$convert_i64_s":		0xb9,
  "f64$convert_i64_u":		0xba,
  "i64$reinterpret_f64":	0xbd,
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
  i64:				0x7e,
  i32:				0x7f
};

const encode = ((t) => t.encode.bind(t))(new TextEncoder),
      decode = ((t) => t.decode.bind(t))(new TextDecoder);

function wasm_encode_string (str) {
  const encoded = encode(str);
  return [...uleb128i32(encoded.length), ...encoded];
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
  // type
  [[wasm.func, 1, wasm.i32, 0]],
  // memory
  [[
    ...wasm_encode_string("imports"),
    ...wasm_encode_string("memory"),
    2, 3, 1, ...uleb128i32(65536)
  ]],
  // tag_import
  [
    [
      ...wasm_encode_string("imports"),
      ...wasm_encode_string("exception_tag"),
      4, 0, 0
    ]
  ],
  // func_import
  [],
  // func
  [],
  // table
  [[wasm.funcref, 0, 0]],
  // tag
  [[0, 0]],
  // export
  [],
  // start
  [],
  // elem
  [],
  // code
  [],
  // data
  []
];

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
      num = arr32[0],
      byt_cnt = 0,
      bytes = new Uint8Array(3),
      string = '';

  while (i < len) {
    while (byt_cnt < 3) {
      const byt = num & 0x7f;
      num >>>= 7;
      bytes[byt_cnt++] = byt | (num ? 0x80 : 0);
      if (num === 0) {
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

function read_type_section (byt) {
  if (!this.arr) {
    // this.read_num is section length - ignore & read arr length next
    this.read_varuint = true;
    this.arr = [];
  } else if (!this.arr_cnt) { 
    this.arr_cnt = this.read_num;
  } else if (this.params) {
    if (!this.params_cnt) {
      this.params_cnt = this.read_num;
      this.curr.push(this.read_num);
    } else {
      this.params.push(byt);
    }
    if (this.params.length === this.params_cnt) {
      this.curr.push(...this.params);
      delete this.params;
      delete this.params_cnt;
      this.results = [];
      this.read_varuint = true;
    }
  } else if (this.results) {
    if (!this.results_cnt) {
      this.results_cnt = this.read_num;
      this.curr.push(this.read_num);
    } else {
      this.results.push(byt);
    }
    if (this.results.length === this.results_cnt) {
      this.curr.push(...this.results);
      this.arr.push(this.curr);
      delete this.results;
      delete this.results_cnt;
      delete this.curr;
      if (this.arr.length === this.arr_cnt) {
        module_sections.push(this.arr);
        return;
      }
    }
  } else {
    this.curr = [byt];
    this.params = [];
    this.read_varuint = true;
  }
  return this;
};

function read_import_section (byt) {
  if (!this.mem) {
    this.mem = [];
    this.tag = [];
    this.func = [];
    // read count
    this.read_varuint = true;
  } else if (this.mod_nm_len) {
    this.curr.push(byt);
    if (!--this.mod_nm_len) {
      // read exp_nm_len
      this.read_varuint = true;
      this.mod_nm = false;
      this.exp_nm = true;
    }
  } else if (this.mod_nm) {
    this.mod_nm_len = this.read_num;
    this.curr.push(...this.read_bytes);
  } else if (this.exp_nm_len) {
    this.curr.push(byt);
    if (!--this.exp_nm_len) {
      this.read_kind = true;
      this.exp_nm = false;
    }
  } else if (this.exp_nm) {
    this.exp_nm_len = this.read_num;
    this.curr.push(...this.read_bytes);
  } else if (this.read_kind) {
    this.curr.push(byt);
    this.kind = byt;
    this.read_kind = false;
    switch (byt) {
      // function
      case 0:
        this.fields = 1;
        this.read_varuint = true;
      break;
      // memory
      case 2: this.fields = 3; break;
      // tag
      case 4: this.fields = 2;
    }
  } else if (this.fields) {
    this.fields--;
    switch (this.kind) {
      // function
      case 0:
        this.curr.push(...this.read_bytes);
      break;
      // memory
      case 2:
        if (this.fields) {
          this.curr.push(byt);
          if (this.fields === 1) this.read_varuint = true;
        } else {
          this.curr.push(...this.read_bytes);
        }
      break;
      // tag
      case 4: this.curr.push(byt);
    }
    if (!this.fields) {
      switch (this.kind) {
        case 0: this.func.push(this.curr); break;
        case 2: this.mem.push(this.curr); break;
        case 4: this.tag.push(this.curr); break;
      }
      if (!--this.all_cnt) {
        module_sections.push(this.mem, this.tag, this.func);
        return;
      } else {
        // read module name string length
        this.read_varuint = true;
        this.mod_nm = true;
        this.curr = [];
      }
    }
  } else {
    if (!this.all_cnt) this.all_cnt = this.read_num;
    // read module name string length
    this.read_varuint = true;
    this.mod_nm = true;
    this.curr = [];
  }
  return this;
}

function read_func_section (byt) {
  if (!this.arr) {
    this.arr = [];
    // read number of functions
    this.read_varuint = true;
  } else if (!this.cnt) {
    this.cnt = this.read_num;
    this.read_varuint = true;
  } else {
    this.arr.push(this.read_num);
    this.read_varuint = true
    if (!--this.cnt) {
      module_sections.push(this.arr);
      return;
    }
  }
  return this;
}

function read_table_section (byt) {
  if (!this.arr) {
    this.arr = [];
    this.read_varuint = true;
  } else if (!this.cnt) {
    this.cnt = this.read_num;
    this.curr = [];
  } else {
    switch (this.curr.length) {
      case 0:
        this.curr.push(byt);
        this.read_varuint = true;
      break;
      case 1:
        this.curr.push(this.read_num);
        this.read_varuint = true;
      break;
      case 2:
        this.curr.push(this.read_num);
        this.arr.push(this.curr);
        this.curr = [];
        if (!--this.cnt) {
          module_sections.push(this.arr);
          return;
        }
    }
  }
  return this;
}

function read_tag_section (byt) {
  if (!this.arr) {
    this.arr = [];
    this.curr = [];
    this.read_varuint = true;
  } else if (!this.cnt) {
    this.cnt = this.read_num;
  } else {
    this.curr.push(byt);
    if (this.curr.length === 2) {
      this.arr.push(this.curr);
      if (!--this.cnt) {
        module_sections.push(this.arr);
        return;
      }
    }
  }
  return this;
}

function read_export_section (byt) {
  if (!this.arr) {
    this.arr = [];
    this.read_varuint = true;
  } else if (!this.cnt) {
    this.cnt = this.read_num;
    this.read_varuint = true;
  } else if (!this.curr) {
    this.name_len = this.read_num;
    this.curr = [this.name_len];
  } else if (this.name_len) {
    this.curr.push(byt);
    if (!--this.name_len) this.kind = true;
  } else if (this.kind) {
    this.curr.push(byt);
    this.kind = false;
    this.read_varuint = true;
  } else {
    this.curr.push(...this.read_bytes);
    this.arr.push(this.curr);
    delete this.curr;
    this.read_varuint = true;
    if (!--this.cnt) {
      module_sections.push(this.arr);
      return;
    }
  }
  return this;
}

function read_start_section (byt) {
  // discard start section; only want in precompiled code
  if (!this.cnt) {
    this.read_varuint = true;
    this.cnt = 1;
  } else {
    this.read_varuint = true;
    if (!--this.cnt) return;
  }
  return this;
}

function read_elem_section (byt) {
  // empty start section
  if (!this.arr) {
    module_sections.push([]);
    this.read_varuint = true;
    this.arr = [];
  } else if (!this.curr) {
    this.cnt = this.read_num;
    this.curr = [];
    this.curr_cnt = 0;
  } else {
    switch (this.curr_cnt++) {
      case 0:
      case 6:
        this.curr.push(byt);
        this.read_varuint = true;
      break;
      case 2:
        this.curr.push(byt);
        this.read_varsint = true;
      break;
      case 1:
      case 3:
        this.curr.push(...this.read_bytes);
      break;
      case 4:
      case 5:
        this.curr.push(byt);
      break;
      case 7:
        this.curr.push(...this.read_bytes);
        this.arr.push(this.curr);
        this.curr = [];
        this.curr_cnt = 0;
        if (!--this.cnt) {
          module_sections.push(this.arr);
          return;
        }
    }
  }
  return this;
}

function read_code_section (byt) {
  if (!this.arr) {
    this.arr = [];
    this.read_varuint = true;
  } else if (!this.curr) {
    this.curr = [];
    this.cnt = this.read_num;
    this.read_varuint = true;
  } else if (!this.curr_cnt) {
    this.curr.push(...this.read_bytes);
    this.curr_cnt = this.read_num;
  } else {
    this.curr.push(byt);
    if (!--this.curr_cnt) {
      this.arr.push(this.curr);
      this.curr = [];
      this.read_varuint = true;
      if (!--this.cnt) {
        module_sections.push(this.arr);
        return;
      }
    }
  }
  return this;
}

function read_data_section (byt) {
  if (!this.arr) {
    this.init_cnt = 6;
    this.arr = [];
  } else if (this.init_cnt) {
    this.init_cnt--;
    if (this.init_cnt === 1) this.read_varuint = true;
    if (!this.init_cnt) this.cnt = this.read_num;
  } else {
    this.arr.push(byt);
    if (!--this.cnt) {
      module_sections.push(this.arr);
      return;
    }
  }
  return this;
}

function get_section_reader (byt) {
  return {
    num: 0,
    shift: 0,
    // start by reading section length
    read_varuint: true,
    reader: (function () {
      switch (byt) {
        case 1:  return read_type_section;
        case 2:  return read_import_section;
        case 3:  return read_func_section;
        case 4:  return read_table_section;
        case 13: return read_tag_section;
        case 7:  return read_export_section;
        case 8:  return read_start_section;
        case 9:  return read_elem_section;
        case 10: return read_code_section;
        case 11: return read_data_section;
      }
    })()
  };
}

function build_module_sections (bytes, idx, end, reader) {
  for (let i = idx; i < end; i++) {
    const byt = bytes[i];
    if (!reader) {
      reader = get_section_reader(byt);
    } else {
      if (reader.read_varsint || reader.read_varuint) {
        if (reader.shift === 0) {
          reader.read_bytes = [byt];
        } else {
          reader.read_bytes.push(byt);
        }
        reader.num |= (byt & 0x7f) << reader.shift;
        reader.shift += 7;
        if ((byt & 0x80) === 0) {
          if (reader.read_varsint) {
            if (reader.shift < 32 && (byt & 0x40) !== 0) {
              reader.num |= (~0 << reader.shift);
            }
          }
          reader.read_varuint = false;
          reader.read_varsint = false;
          reader.read_num = reader.num;
          reader.num = 0;
          reader.shift = 0;
        }
      }
      if (!reader.read_varuint && !reader.read_varsint) {
        reader = reader.reader(byt);
      }
    }
  }
  return reader;
}

function b64_decode (string, module_len, offset) {
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
      reader,
      start_funcs_idx = 0,
      end_byte = 0;

  const buff = new ArrayBuffer(buff_len),
        arr32 = new Uint32Array(buff),
        arr8 = new Uint8Array(buff, offset, module_len),
        start_funcs_32 = new Uint32Array(start_funcs_buf);

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
        let start_byte = end_byte || (idx * 4 - offset >= 8 ? 8 : 0);
        if (start_byte < module_len) {
          arr32[idx++] = num;
          // skip preamble:
          if (start_byte >= 8) {
            end_byte = idx * 4 - offset;
            reader = build_module_sections(
              arr8, start_byte, end_byte, reader
            );
          }
        } else {
          start_funcs_32[start_funcs_idx++] = num;
        }
        num = 0;
        shift = 0;
      }
    }
  }

  return arr8;
};

// todo: what are we doing with precompiled?
let precompiled = null;

if (module_len) precompiled = b64_decode(module_code, module_len, module_off);

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
  spec.uleb128 = uleb128i32(spec.func_idx);
  spec.sleb128 = sleb128i32(spec.func_idx);
  return spec;
}

function func_wrapper (spec, cb) {
  spec.type_idx = _get_type_idx(spec);
  if (!spec.uleb128) reserve_func_num(spec);
  cb();
  return spec;
}

function func (spec) {
  return func_wrapper(spec, function () {
    const func_num = spec.func_idx - import_num;
    module_sections[func_section][func_num] = spec.type_idx;
    if (spec.export) {
      if (possible_exports) {
        possible_exports[spec.export] = module_sections[export_section].length;
      }
      module_sections[export_section].push([
        ...wasm_encode_string(spec.export), 0,
        ...spec.uleb128
      ]);
    }
    const locals = [0];
    let curr_type;
// todo: this is not catching when the same type was earlier in the list
    for (const t of spec.locals) {
      if (t === curr_type) {
        locals[locals.length - 2]++;
      } else {
        locals.push(1, t);
        locals[0]++;
        curr_type = t;
      }
    }
    for (let i = 0; i < locals.length; i++) {
      const leb128 = uleb128i32(locals[i]);
      locals.splice(i, 1, ...leb128);
      if (i) i += leb128.length;
    }
    spec.code.unshift(...locals);
    spec.code.push(wasm.end);
    module_sections[code_section][func_num] = [
      ...uleb128i32(spec.code.length), ...spec.code
    ];
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

const print_func_num = import_func(
  0, 0, 0, [],
  function () { console.log(func_num); }
);

const get_type_idx = import_func(
  6, 0, 0, [wasm.i32],
  function (
    i32_params,
    i64_params,
    f64_params,
    i32_results,
    i64_results,
    f64_results,
  ) {
    const params = [], result = [];
    for (let i = 0; i < i32_params; i++) params.push(wasm.i32);
    for (let i = 0; i < i64_params; i++) params.push(wasm.i64);
    for (let i = 0; i < f64_params; i++) params.push(wasm.f64);
    for (let i = 0; i < i32_results; i++) result.push(wasm.i32);
    for (let i = 0; i < i64_results; i++) result.push(wasm.i64);
    for (let i = 0; i < f64_results; i++) result.push(wasm.f64);
    return _get_type_idx({ params, result });
  }
);

// todo: get rid of this and comp function
const print_i32 = import_func(
  1, 0, 0, [],
  function (i32) {
    const a = new Uint32Array([i32]);
    console.log(a[0]);
  }
);

const print_i64 = import_func(
  0, 1, 0, [],
  function (i64) {
    console.log(i64);
  }
);

const print_string = import_func(
  1, 0, 0, [],
  function (str) {
    console.log(comp_string_to_js(str));
  }
);

end_package();

const funcs = {
  comp: [],
  build: func_builder
};

function func_builder (params, results, opts, code_builder) {
  let local_num = params.length;
  const spec = {
    params: params,
    locals: [],
    code: [],
    result: results
  };
  function callback (func_builder, code_builder) {
    const param_idx = [];
    for (let i = 0; i < params.length; i++) {
      param_idx.push(uleb128i32(i));
    }
    if (opts.export) spec.export = opts.export;
    spec.code.push(...code_builder.call(func_builder, ...param_idx));
    return func(spec);
  }
  reserve_func_num(spec);
  store_func_for_comp(params, results, spec.func_idx, opts);
  // allows defining function and building later
  spec.build = callback.bind(null, {
    local: function (type) {
      spec.locals.push(type);
      return uleb128i32(local_num++);
    },
    uleb128: spec.uleb128
  });
  if (code_builder) return spec.build(code_builder);
  return spec;
}

function store_func_for_comp (params, results, func_idx, opts) {
  if (opts.comp) {
    let params_i32 = 0,
        params_i64 = 0,
        params_f64 = 0,
        result_i32 = 0,
        result_i64 = 0,
        result_f64 = 0;
    params = params.map(function (p) {
      if (typeof p === "object") p = p.wasm_type;
      switch (p) {
        case wasm.i32: params_i32++; break;
        case wasm.i64: params_i64++; break;
        case wasm.f64: params_f64++;
      }
      return p;
    });
    results = results.map(function (p) {
      if (typeof p === "object") p = p.wasm_type;
      switch (p) {
        case wasm.i32: result_i32++; break;
        case wasm.i64: result_i64++; break;
        case wasm.f64: result_f64++;
      }
      return p;
    });
    if (opts.comp_wrapper) {
      func_idx = funcs.build(params, results, {}, function (...params) {
        let code = [];
        for (let i = 0; i < params.length; i++) {
          code.push(wasm.local$get, ...uleb128i32(i));
        }
        code.push(wasm.call, ...uleb128i32(func_idx));
        for (let i = 0; i < opts.comp_wrapper.length; i++) {
          code = opts.comp_wrapper[i](this, code);
        }
        return code;
      }).func_idx;
    }
    params = [...params, wasm.i32];
    func_idx = funcs.build(params, results, {}, function (...params) {
      let code = [];
      for (let i = 0; i < params.length - 1; i++) {
        code.push(wasm.local$get, ...uleb128i32(i));
      }
      code.push(wasm.call, ...uleb128i32(func_idx));
      return code;
    }).func_idx;
    funcs.comp.push([
      opts.comp,
      params_i32, params_i64, params_f64,
      result_i32, result_i64, result_f64,
      func_idx
    ]);
  }
}

begin_package();

/*---------*\
|           |
| ref table |
|           |
\*---------*/

// todo: why can't we return 0 as an index?
// const ref_table = [null];

// let next_ref_address = 0;

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

const print_code = import_func(
  1, 0, 0, [],
  function print_code (idx) {
    const code = open_funcs[idx].code;
    let out = "",
        i = 0,
        shift = 0,
        num = 0,
        sleb32 = 0,
        uleb32 = 0,
        bytes = 0;
    for (let i = 0; i < code.length; i++) {
      if (bytes) {
        bytes--;
        out += ` ${code[i]}`;
      } else {
        num |= (code[i] & 0x7f) << shift;
        shift += 7;
        if ((code[i] & 0x80) === 0) {
          if (sleb32) {
            sleb32--;
            if (shift < 32 && (code[i] & 0x40) !== 0) {
              num |= (~0 << shift);
            }
            out += ` ${num}`;
          } else if (uleb32) {
            uleb32--;
            out += ` ${num}`;
          } else {
            for (const op in wasm) {
              if (wasm[op] === num) {
                out += `\n${op}`;
                break;
              }
            }
            switch (num) {
              case wasm.i32$const:
                sleb32 = 1;
              break;
              // case wasm.i64$const: 
              // case wasm.f64$const: 
              case wasm.local$get:
              case wasm.local$set:
              case wasm.local$tee:
              case wasm.call:
              case wasm.br:
              case wasm.br_if:
                uleb32 = 1;
              break;
              case wasm.call_indirect:
                uleb32 = 2;
              break;
              case wasm.if:
              case wasm.block:
              case wasm.loop:
                bytes = 1;
              break;
              case wasm.i32$load:
              case wasm.i32$store:
                bytes = 2;
              break;
            }
          }
          num = 0;
          shift = 0;
        }
      }
    }
    console.log(out);
  }
);

const end_func = import_func(
  1, 0, 0, [wasm.i32],
  function (idx) {
    const out = func(open_funcs[idx]);
	  //if (out.func_idx === 1111) {console.log(out);print_code(idx);}
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
  1, 0, 0, [], fidx => start_funcs.push(fidx)
);

/*-------*\
|         |
| compile |
|         |
\*-------*/

let comp;

const section_builders = {
  import_section: function f () {
    const memory = module_sections[memory_import_section],
          tag = module_sections[tag_import_section],
          func = module_sections[func_import_section],
          is = [...memory, ...tag, ...func],
          sec = [...uleb128i32(is.length), ...is.flat()],
          built = [2,  ...uleb128i32(sec.length), ...sec];
    this.import_section = function () { return built; };
    return built;
  },
  type_section: function f () {
    const ts = module_sections[type_section],
          len = ts.length,
          sec = [...uleb128i32(len), ...ts.flat()],
          built = [1, ...uleb128i32(sec.length), ...sec];
    this.type_section = function () {
      if (module_sections[type_section].length === len) return built;
      return f.call(this);
    };
    return built;
  },
  func_section: function f () {
    const fs = [];
    for (const f of module_sections[func_section]) {
      fs.push(...sleb128i32(f));
    }
    const len = fs.length,
          sec = [...uleb128i32(len), ...fs],
          built = [3, ...uleb128i32(sec.length), ...sec];
    this.func_section = function () {
      if (module_sections[func_section].length === len) return built;
      return f.call(this);
    };
    return built;
  },
  table_section: function f () {
    const ts = module_sections[table_section],
          len = ts.length,
          es_len = module_sections[elem_section].length,
          flat = [];
    for (const [type, flags, size] of ts) {
      flat.push(type, flags, ...uleb128i32(size));
    }
    const sec = [...uleb128i32(len), ...flat],
          built = [4, ...uleb128i32(sec.length), ...sec];
    this.table_section = function () {
      if (
        module_sections[table_section].length === len &&
        module_sections[elem_section].length === es_len
      ) return built;
      return f.call(this);
    };
    return built;
  },
  tag_section: function () {
    const ts = [
            ...uleb128i32(module_sections[tag_section].length),
            ...module_sections[tag_section].flat()
          ],
          built = [13, ...uleb128i32(ts.length), ...ts];
    this.tag_section = () => built;
    return built;
  },
  export_section: function f () {
    const es = module_sections[export_section],
          len = es.length,
          sec = [...uleb128i32(len), ...es.flat()],
          built = [7, ...uleb128i32(sec.length), ...sec];
    this.export_section = function () {
      if (module_sections[export_section].length === len) return built;
      return f.call(this);
    };
    return built;
  },
  elem_section: function f () {
    const es = module_sections[elem_section],
          len = es.length,
          sec = [...uleb128i32(len), ...es.flat()],
          built = [9, ...uleb128i32(sec.length), ...sec];
    this.elem_section = function () {
      if (module_sections[elem_section].length === len) return built;
      return f.call(this);
    };
    return built;
  },
  data_section: function () {
    const ds = module_sections[data_section],
          len = ds.length;
    if (len) {
      const sec = [
              1, 0, wasm.i32$const, 0, wasm.end,
              ...uleb128i32(len), ...ds
            ];
      module_sections[data_section] = [];
      return [11, ...uleb128i32(sec.length), ...sec];
    }
    return [];
  }
};

// todo: can use Uint8Array directly? Faster?
function build_module_code () {
  const ssl = module_sections[start_section].length,
        ss = ssl ? [
          8, ...uleb128i32(ssl), ...module_sections[start_section]
        ] : [],
        cs = [
          ...uleb128i32(module_sections[code_section].length),
          ...module_sections[code_section].flat()
        ];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section_builders.type_section(),
    ...section_builders.import_section(),
    ...section_builders.func_section(),
    ...section_builders.table_section(),
    ...section_builders.tag_section(),
    ...section_builders.export_section(),
    ...ss,
    ...section_builders.elem_section(),
    10, ...uleb128i32(cs.length), ...cs,
    ...section_builders.data_section()
  ]);
}

const compile = import_func(
  0, 0, 0, [],
  function (code) {
    do {
      const start_func = start_funcs.shift();
      if (start_func) module_sections[start_section] = uleb128i32(start_func);
      const module_code = code || build_module_code(),
            mod = new WebAssembly.Module(module_code),
            inst = new WebAssembly.Instance(mod, { imports });
      if (start_func) {
        module_sections[code_section][start_func - import_num] = [2, 0, 0xb];
      }
      comp = inst.exports;
    } while (start_funcs.length);
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
  function (obj_prop, start, len) {
    obj_prop = load_ref(obj_prop).split(".");
    // obj_prop = comp_string_to_js(obj_prop).split(".");
    let obj = js_imports;
    for (let i = 0; i < obj_prop.length; i++) {
      obj = obj[obj_prop[i]];
    }
    const args = ref_table.slice(start, start + len);
    return comp.Object(store_ref(obj(...args)));
  }
);

end_package();

/*-------*\
|         |
| package |
|         |
\*-------*/

function slice_source (str) {
  const package_start = "\nbegin_package();\n",
        package_end = "\nend_package();\n";
  let start_cut = str.indexOf(package_start),
      out = str.slice(0, start_cut);
  while (start_cut > -1) {
    const end_cut = str.indexOf(package_end, start_cut),
          cut_point = start_cut + package_start.length;
    out += str.slice(cut_point, end_cut);
    start_cut = str.indexOf(package_start, cut_point);
  }
  return out + "}";
}

function prune_exports () {
  const new_exports = [],
        old_exports = module_sections[export_section];
  for (let e of [
    "File",
    "eval_stream",
    "File$fd",
    "array_by_length",
    "Array$arr",
    "String",
    "String$length",
    "String$arr",
    "Array$length",
    "array_get_i32",
    "to_js",
    "Object$address",
    "Object",
    "free",
    "Exception$msg"
  ]) {
    new_exports.push(old_exports[possible_exports[e]]);
  }
  module_sections[export_section] = new_exports;
}

let next_addr;

// todo: how to build package file from within one?
function build_package () {
  let func_code = slice_source(build_comp.toString());
  func_code += `(${init.toString()}).call(this,`;
// todo: make sure only JSON friendly data is in ref_table
  func_code += `${JSON.stringify(ref_table)},${next_ref_address},`;
  const last_addr = new DataView(memory.buffer).getUint32(next_addr, true);
  module_sections[data_section] = new Uint8Array(memory.buffer, 0, last_addr);
  let module_b64, off;
  prune_exports();
  const module_code = build_module_code(),
        module_len = module_code.length,
        start_funcs_len = start_funcs.length * 4,
        start_funcs_8 = new Uint8Array(new Uint32Array(start_funcs).buffer),
        full_len = module_len + start_funcs_len;
  for (let i = 0; i < 4; i++) {
    // length needs to be multiple of 4 to use Uint32Array in b64_encode:
    const bytes = new Uint8Array(Math.ceil((full_len + i) / 4) * 4);
// todo: can we make this faster?
    bytes.set(module_code, i);
    bytes.set(start_funcs_8, module_len + i);
    const temp_b64 = b64_encode(bytes);
    if (!module_b64 || (temp_b64.length < module_b64.length)) {
      module_b64 = temp_b64;
      off = i;
    }
  }
  func_code += `"${module_b64}",${module_len},${off},${start_funcs_len},${last_addr});`;
  const {minify} = require("uglify-js");
  if (typeof minify !== "undefined") func_code = minify(func_code).code;
  return func_code;
}

function begin_package () {
  in_package = true;
}

function end_package () {
  in_package = false;
}

begin_package();

/*--------------*\
|                |
| string interop |
|                |
\*--------------*/

// todo: make method for fileslice & string
function comp_string_to_js (addr) {
  const len = comp.String$length(addr),
        arr = comp.String$arr(addr),
        bytes = new DataView(memory.buffer, comp.Array$arr(arr), len);
  return decode(bytes);
}

const store_string = import_func(
  1, 0, 0, [wasm.i32],
  function (str) {
// todo: use abovementioned method
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

const get_op_code = import_func(
  2, 0, 0, [wasm.i32],
  function (namespace, name) {
    const ns_str = comp_string_to_js(namespace);
    let op_name = comp_string_to_js(name);
    if (ns_str) op_name = ns_str + "$" + op_name;
    return wasm[op_name];
  }
);

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

// todo: make sure idx < len
const file_read_byte = import_func(
  2, 0, 0, [wasm.i32],
  function (file, idx) {
    const buf = new Uint8Array(1);
    fs.readSync(comp.File$fd(file), buf, 0, 1, idx);
    return buf[0];
  }
);

// todo: make sure idx < len
const file_read_i32 = import_func(
  2, 0, 0, [wasm.i32],
  function (file, idx) {
    const buf = new Uint32Array(1);
    fs.readSync(comp.File$fd(file), buf, 0, 4, idx);
    return buf[0];
  }
);

// todo: make sure idx < len
const file_read_i64 = import_func(
  2, 0, 0, [wasm.i64],
  function (file, idx) {
    const buf = new BigInt64Array(1);
    fs.readSync(comp.File$fd(file), buf, 0, 8, idx);
    return buf[0];
  }
);

const file_get_string_chunk = import_func(
  4, 0, 0, [wasm.i32],
  function (fstr, str, start, len) {
    const arr = comp.String$arr(str),
// todo: update global DataView when memory grows
          buf = new DataView(memory.buffer),
          fd = comp.File$fd(fstr),
          br = fs.readSync(fd, buf, comp.Array$arr(arr), len, start);
    return str;
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
      //expanding_forms = curr_addr += 4;

end_package();

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

const i32_div_ceil = funcs.build(
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

const get_next_address = funcs.build(
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
                wasm.call, ...i32_div_ceil.uleb128,
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

const alloc = funcs.build(
  [wasm.i32], [wasm.i32], { export: "alloc" },
  function (type_size) {
    // size in bytes
    const addr = this.local(wasm.i32);
    return [
      // load previously freed address for type and set as addr
      // type_size is also address where freed blocks are stored
      wasm.local$get, ...type_size,
      wasm.i32$const, 0,
      wasm.atomic$prefix,
      // replace address with zero so other threads will use get_next_address until done
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
        wasm.call, ...get_next_address.uleb128,
      wasm.end
    ];
  }
);

const free_mem = funcs.build(
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

const get_ops_for_field_type = funcs.build(
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

const make_accessor_func = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (type_size, field_name, result_type, mem_size, load_op) {
    const _func = this.local(wasm.i32);
    return [
      wasm.call, ...start_func.uleb128,
      wasm.local$tee, ..._func,
      wasm.local$get, ...field_name,
      wasm.if, wasm.void,
        wasm.local$get, ..._func,
        wasm.local$get, ...field_name,
        wasm.call, ...set_export.uleb128,
        wasm.drop,
      wasm.end,
      // first param is value address
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_param.uleb128,
      // result type is field type
      wasm.local$get, ...result_type,
      wasm.call, ...add_result.uleb128,
      // get value address
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.uleb128,
      // add type-size (current offset)
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...type_size,
      wasm.call, ...append_varsint32.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.i32$add),
      wasm.call, ...append_code.uleb128,
      // load data
      wasm.local$get, ...load_op,
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...mem_size,
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.uleb128,
      wasm.call, ...end_func.uleb128
    ];
  }
);

// todo: use offset instead of setter_func
const add_field_to_type_constructor = funcs.build(
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
      wasm.call, ...add_param.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...field_num,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$tee, ...field_num,
      wasm.call, ...append_varuint32.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...setter_func,
      wasm.call, ...append_varuint32.uleb128,
      wasm.drop,
      wasm.local$get, ...use_default,
      // if default given, then add it to the code of the constructor_func
      wasm.if, wasm.i32,
        wasm.local$get, ...outer_func,
        wasm.local$get, ...const_op,
        wasm.call, ...append_code.uleb128,
        wasm.local$get, ..._default,
        wasm.call, ...append_varsint32.uleb128,
      // otherwise, add it as a parameter to the constructor_func
      wasm.else,
        wasm.local$get, ...outer_func,
        wasm.local$get, ...field_type,
        wasm.call, ...add_param.uleb128,
        wasm.i32$const, ...sleb128i32(wasm.local$get),
        wasm.call, ...append_code.uleb128,
        wasm.local$get, ...param_num,
        wasm.call, ...append_varuint32.uleb128,
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

const create_setter_func = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (field_type, offset, mem_size, store_op) {
    return [
      wasm.call, ...start_func.uleb128,
      // first param is value address
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_param.uleb128,
      wasm.local$get, ...field_type,
      wasm.call, ...add_param.uleb128,
      // get value address
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...offset,
      wasm.call, ...append_varsint32.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.i32$add),
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, 1,
      wasm.call, ...append_varuint32.uleb128,
      wasm.local$get, ...store_op,
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...mem_size,
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.uleb128,
      wasm.call, ...end_func.uleb128
    ];
  }
);

const add_type_field = funcs.build(
  [
    wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32,
    wasm.i32, wasm.i32, wasm.i32, wasm.i32
  ],
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  { export: "add_type_field" },
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
      wasm.call, ...get_ops_for_field_type.uleb128,
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
      wasm.call, ...make_accessor_func.uleb128,
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
      wasm.call, ...create_setter_func.uleb128,
  
      wasm.call, ...add_field_to_type_constructor.uleb128,
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

const start_type = funcs.build(
  [], [wasm.i32, wasm.i32], { export: "start_type" },
  function () {
    return [
      wasm.call, ...start_func.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_param.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_result.uleb128,
      wasm.call, ...start_func.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_result.uleb128
    ];
  }
);

const end_type = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32],
  { export: "end_type" },
  function (
    inner_func,
    outer_func,
    type_size,
    field_num,
    type_name
  ) {
    return [
      wasm.local$get, ...type_name,
      wasm.if, wasm.void,
        wasm.local$get, ...outer_func,
        wasm.local$get, ...type_name,
        wasm.call, ...set_export.uleb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...outer_func,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...inner_func,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.uleb128,
      wasm.call, ...end_func.uleb128,
      wasm.call, ...append_varuint32.uleb128,
      wasm.i32$const, ...alloc.sleb128,
      wasm.call, ...prepend_varuint32.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...prepend_code.uleb128,
      wasm.local$get, ...type_size,
      wasm.call, ...prepend_varsint32.uleb128,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...prepend_code.uleb128,
      wasm.call, ...end_func.uleb128,
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

// todo: max type num 255?
function define_type (type_name, xpt_constr, ...fields) {
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
  fields.unshift("_type_num", "i32", 1, type_num, 0, 0);
  for (let i = 0; i < fields.length; i += 6) {
    const field_name = fields[i],
          field_type = fields[i + 1],
          use_default = fields[i + 2],
          deft = fields[i + 3],
          comp_type = fields[i + 4],
          xpt = fields[i + 5],
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
      xpt ? store_ref(type_name + "$" + field_name) : 0,
      wasm[field_type],
      use_default, deft
    );
    type_info.fields[field_name] = {
      func_idx: acc_func,
      uleb128: uleb128i32(acc_func),
      wasm_type: wasm[field_type],
      offset: field_offset
    };
    if (comp_type) {
      const res = comp_type === wasm[field_type] ? comp_type : wasm.i32;
      store_func_for_comp(
        [wasm.i32], [res], acc_func, {
          comp: [`comp.${type_name}`, field_name],
	  comp_wrapper: comp_type === wasm[field_type] || [wrap_result_i32_to_int]
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
    xpt_constr ? store_ref(type_name) : 0
  );
  type_info.constr = {
    func_idx: outer_func,
    uleb128: uleb128i32(outer_func),
    params: params
  };
  store_func_for_comp(
    params, [wasm.i32], outer_func, { comp: [`comp.${type_name}`, "new"] }
  );
  type_info.size = type_size;
}

define_type("Nil", 0);
define_type("False", 0);
define_type("True", 0);

const refs_default = 0;

define_type(
  "Int", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "value", "i64", 0, 0, wasm.i64, 0
);

define_type(
  "Float", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "value", "f64", 0, 0, wasm.f64, 0
);

define_type(
  "Object", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "address", "i32", 0, 0, 0, 1
);

define_type(
  "String", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "arr", "i32", 0, 0, 0, 1,
  "length", "i32", 0, 0, 0, 1
);

define_type(
  "File", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "fd", "i32", 0, 0, 0, 1,
  "length", "i32", 0, 0, 0, 0,
);

define_type(
  "FileSlice", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "file", "i32", 0, 0, 0, 0,
  "start", "i32", 0, 0, 0, 0,
  "length", "i32", 0, 0, 0, 0,
);

define_type(
  "Exception", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "data", "i32", 0, 0, 0, 0,
  "msg", "i32", 0, 0, 0, 1
);

define_type(
  "Symbol", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "namespace", "i32", 0, 0, wasm.i32, 0,
  "name", "i32", 0, 0, wasm.i32, 0
);

define_type(
  "Keyword", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "namespace", "i32", 0, 0, wasm.i32, 0,
  "name", "i32", 0, 0, wasm.i32, 0
);

define_type(
  "Function", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "func_num", "i32", 0, 0, 0, 1,
  "tbl_idx", "i32", 0, 0, 0, 0,
  "type_num", "i32", 0, 0, 0, 0,
  "result",  "i32", 0, 0, 0, 0,
  "i32_params", "i32", 0, 0, 0, 0,
  "i64_params", "i32", 0, 0, 0, 0,
  "f64_params", "i32", 0, 0, 0, 0,
  "scope", "i32", 0, 0, 0, 0
);

define_type(
  "Function2", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "func_num", "i32", 0, 0, 0, 1,
  "tbl_idx", "i32", 0, 0, 0, 0,
  "type_num", "i32", 0, 0, 0, 0,
  "result",  "i32", 0, 0, 0, 0,
  "i32_params", "i32", 0, 0, 0, 0,
  "i64_params", "i32", 0, 0, 0, 0,
  "f64_params", "i32", 0, 0, 0, 0,
  "i32_results", "i32", 0, 0, 0, 0,
  "i64_results", "i32", 0, 0, 0, 0,
  "f64_results", "i32", 0, 0, 0, 0,
  "scope", "i32", 0, 0, 0, 0
);

define_type(
  "Method", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "num", "i32", 0, 0, 0, 0,
  "default_func", "i32", 0, 0, 0, 0,
  "main_func", "i32", 0, 0, 0, 0
);

define_type(
  "Array", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "arr", "i32", 0, 0, 0, 1,
  "length", "i32", 0, 0, 0, 1,
  "original", "i32", 0, 0, 0, 0
);

define_type(
  "RefsArray", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "arr", "i32", 0, 0, 0, 0
);

define_type(
  "Atom", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "data", "i32", 0, 0, 0, 0,
  "mutex", "i32", 0, 0, 0, 0
);

define_type(
  "TaggedData", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "tag", "i32", 0, 0, 0, 0,
  "data", "i32", 0, 0, 0, 0
);

define_type(
  "Metadata", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "meta", "i32", 0, 0, 0, 0,
  "data", "i32", 0, 0, 0, 0
);

define_type(
  "Type", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "num", "i32", 0, 0, 0, 0
);

define_type(
  "PartialNode", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "arr", "i32", 0, 0, 0, 0,
  "bitmap", "i32", 0, 0, 0, 0
);

define_type(
  "FullNode", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "arr", "i32", 0, 0, 0, 0
);

define_type(
  "HashCollisionNode", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "arr", "i32", 0, 0, 0, 0,
  "collision_hash", "i32", 0, 0, 0, 0
);

define_type(
  "LeafNode", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "key", "i32", 0, 0, wasm.i32, 0,
  "val", "i32", 0, 0, wasm.i32, 0
);

define_type(
  "HashMap", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "root", "i32", 0, 0, 0, 0,
  "count", "i32", 0, 0, 0, 0
);

define_type(
  "Vector", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "count", "i32", 0, 0, 0, 0,
  "shift", "i32", 0, 0, 0, 0,
  "root", "i32", 0, 0, 0, 0,
  "tail", "i32", 0, 0, 0, 0
);

define_type(
  "VectorSeq", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "arr", "i32", 0, 0, 0, 0,
  "arr_off", "i32", 0, 0, 0, 0,
  "vec", "i32", 0, 0, 0, 0,
  "node_off", "i32", 0, 0, 0, 0
);

define_type(
  "RefsArraySeq", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "arr", "i32", 0, 0, 0, 0,
  "offset", "i32", 0, 0, 0, 0,
);

define_type(
  "HashMapNodeSeq", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "curr_seq", "i32", 0, 0, 0, 0,
  "nodes", "i32", 0, 0, 0, 0,
  "offset", "i32", 0, 0, 0, 0
);

define_type(
  "HashMapSeq", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "map", "i32", 0, 0, 0, 0,
  "root", "i32", 0, 0, 0, 0
);

define_type(
  "LazySeq", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "generator", "i32", 0, 0, 0, 0,
  "seq", "i32", 0, 0, 0, 0,
  "seq_set", "i32", 0, 0, 0, 0
);

define_type(
  "ConsSeq", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "first", "i32", 0, 0, 0, 0,
  "rest", "i32", 0, 0, 0, 0
);

define_type(
  "ConcatSeq", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "left", "i32", 0, 0, 0, 0,
  "right", "i32", 0, 0, 0, 0
);

define_type(
  "SourceSeq", 0,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "start", "i32", 0, 0, 0, 0
);

define_type(
  "Seq", 1,
  "refs", "i32", 1, refs_default, 0, 0,
  "hash", "i32", 1, 0, 0, 0,
  "root", "i32", 0, 0, 0, 0
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

const get_flag = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (val, mask) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...types.Symbol.fields.refs.uleb128,
      wasm.local$get, ...mask,
      wasm.i32$and,
      wasm.i32$const, 0,
      wasm.i32$ne
    ];
  }
);

const set_flag = funcs.build(
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
      wasm.local$get, ...mask,
      wasm.i32$const, ...sleb128i32(-1),
      wasm.i32$xor,
      wasm.i32$and,
      wasm.local$get, ...bit,
      wasm.local$get, ...mask,
      wasm.i32$ctz,
      wasm.i32$shl,
      wasm.i32$or,
      wasm.i32$store, 2, 0,
      wasm.local$get, ...prev,
      wasm.local$get, ...mask,
      wasm.i32$and,
      wasm.i32$const, 0,
      wasm.i32$ne
    ];
  }
);

/*-------*\
|         |
| def_mtd |
|         |
\*-------*/

// add a param to the default func and main func of a polymethod
const add_params_to_main_mtd_func = funcs.build(
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
          wasm.call, ...add_param.uleb128,
          // add to the code of main func
          // (local.get n) where n is the param num we started on plus curr_param
          wasm.i32$const, ...sleb128i32(wasm.local$get),
          wasm.call, ...append_code.uleb128,
          wasm.local$get, ...start_param,
          wasm.local$get, ...curr_param,
          wasm.i32$add,
          wasm.call, ...append_varuint32.uleb128,
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
const finish_mtd_main_func = funcs.build(
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
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.uleb128,
      // load the type num from the address
      wasm.i32$const, ...sleb128i32(wasm.i32$load),
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, 2,
      wasm.call, ...append_varuint32.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...append_varuint32.uleb128,
      // call_indirect using the type num as the index to the poly table
      wasm.i32$const, ...sleb128i32(wasm.call_indirect),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...type_idx,
      wasm.call, ...append_varuint32.uleb128,
      wasm.local$get, ...poly_table,
      wasm.call, ...append_varuint32.uleb128,
      wasm.call, ...end_func.uleb128,
      wasm.local$tee, ...main_func,
      wasm.local$get, ...main_func,
      wasm.call, ...add_to_func_table.uleb128,
      wasm.local$get, ...type_idx,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.local$get, ...i32_params,
      wasm.local$get, ...i64_params,
      wasm.local$get, ...f64_params,
      wasm.i32$const, nil,
      wasm.call, ...types.Function.constr.uleb128
    ];
  }
);

const new_comp_method = funcs.build(
  [
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32
  ],
  [wasm.i32, wasm.i32], { export: "new_comp_method" },
  function (
    mtd_name,
    i32_params,
    i64_params,
    f64_params,
    i32_result,
    i64_result,
    f64_result,
  ) {
    const mtd_table = this.local(wasm.i32),
          main_func = this.local(wasm.i32),
          type_idx = this.local(wasm.i32),
          num_params = this.local(wasm.i32),
          cnt_i32 = this.local(wasm.i32),
          cnt_i64 = this.local(wasm.i32),
          cnt_f64 = this.local(wasm.i32);
    return [
      wasm.call, ...start_func.uleb128,
      wasm.local$tee, ...main_func,
      wasm.local$get, ...mtd_name,
      wasm.if, wasm.void,
        wasm.local$get, ...main_func,
        wasm.local$get, ...mtd_name,
        wasm.call, ...set_export.uleb128,
        wasm.drop,
      wasm.end,
      wasm.loop, wasm.void,
        wasm.local$get, ...i32_result,
        wasm.local$get, ...cnt_i32,
        wasm.i32$gt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...main_func,
          wasm.i32$const, ...sleb128i32(wasm.i32),
          wasm.call, ...add_result.uleb128,
          wasm.drop,
          wasm.local$get, ...cnt_i32,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...cnt_i32,
          wasm.br, 1,
        wasm.end,
        wasm.local$get, ...i64_result,
        wasm.local$get, ...cnt_i64,
        wasm.i32$gt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...main_func,
          wasm.i32$const, ...sleb128i32(wasm.i64),
          wasm.call, ...add_result.uleb128,
          wasm.drop,
          wasm.local$get, ...cnt_i64,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...cnt_i64,
          wasm.br, 1,
        wasm.end,
        wasm.local$get, ...f64_result,
        wasm.local$get, ...cnt_f64,
        wasm.i32$gt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...main_func,
          wasm.i32$const, ...sleb128i32(wasm.f64),
          wasm.call, ...add_result.uleb128,
          wasm.drop,
          wasm.local$get, ...cnt_f64,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...cnt_f64,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.i32$const, 0,
      wasm.local$get, ...i32_params,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.call, ...add_params_to_main_mtd_func.uleb128,
      wasm.local$get, ...i64_params,
      wasm.i32$const, ...sleb128i32(wasm.i64),
      wasm.call, ...add_params_to_main_mtd_func.uleb128,
      wasm.local$get, ...f64_params,
      wasm.i32$const, ...sleb128i32(wasm.f64),
      wasm.call, ...add_params_to_main_mtd_func.uleb128,
      wasm.drop,
      wasm.drop,
      wasm.call, ...new_func_table.uleb128,
      wasm.local$set, ...mtd_table,
      wasm.local$get, ...i32_params,
      wasm.local$get, ...i64_params,
      wasm.local$get, ...f64_params,
      wasm.local$get, ...i32_result,
      wasm.local$get, ...i64_result,
      wasm.local$get, ...f64_result,
      wasm.call, ...get_type_idx.uleb128,
      wasm.local$set, ...type_idx,
      wasm.local$get, ...main_func,
      wasm.local$get, ...type_idx,
      wasm.local$get, ...mtd_table,
      wasm.local$get, ...i32_params,
      wasm.local$get, ...i64_params,
      wasm.local$get, ...f64_params,
      wasm.call, ...finish_mtd_main_func.uleb128,
      wasm.local$get, ...mtd_table
    ];
  }
);

compile();

const defined_methods = [];

function def_mtd (
  arg_i32, arg_i64, arg_f64,
  res_i32, res_i64, res_f64,
  opts, def_func
) {
  const params = [], result = [];
  for (let i = 0; i < arg_i32; i++) params.push(wasm.i32);
  for (let i = 0; i < arg_i64; i++) params.push(wasm.i64);
  for (let i = 0; i < arg_f64; i++) params.push(wasm.f64);
  for (let i = 0; i < res_i32; i++) result.push(wasm.i32);
  for (let i = 0; i < res_i64; i++) result.push(wasm.i64);
  for (let i = 0; i < res_f64; i++) result.push(wasm.f64);
  if (def_func) {
    if (typeof def_func === "function") {
      def_func = funcs.build(params, result, {}, def_func);
    }
  } else if (!def_func) {
    def_func = { func_idx: 0, uleb128: [0], sleb128: [0] };
  }
  const [ mtd_func, mtd_num ] = comp.new_comp_method(
    opts.export ? sleb128i32(store_ref(opts.export)) : [0],
    arg_i32, arg_i64, arg_f64, res_i32, res_i64, res_f64
  );
  const func_idx = comp.Function$func_num(mtd_func);
  return {
    params,
    result,
    mtd_num: mtd_num,
    num_args: arg_i32 + arg_i64 + arg_f64,
    def_func: def_func,
    func_idx: func_idx,
    uleb128: uleb128i32(func_idx),
    sleb128: sleb128i32(func_idx),
    main_func: mtd_func,
// todo: track already implemented and replace previous entry in elem section
    implemented: {},
    implement: function (type, func) {
      this.implemented[type.name] = true;
      impl_method(mtd_num, type.type_num, 
        func instanceof Function ?
        funcs.build(params, result, {}, func).func_idx :
        func
      );
    }
  };
}

// todo: should this be exposing methods? they're exposing functions now
function pre_new_method (
  arg_i32, arg_i64, arg_f64,
  res_i32, res_i64, res_f64,
  opts, def_func
) {
  const out = def_mtd(
    arg_i32, arg_i64, arg_f64,
    res_i32, res_i64, res_f64,
    opts, def_func
  );
  // store function directly as these methods frequently require wrappers
  store_func_for_comp(out.params, out.result, out.func_idx, opts);
  defined_methods.push(out);
  for (let i = 0; i < next_type_num; i++) {
    impl_method(out.mtd_num, i, out.def_func.func_idx);
  }
  return out;
}

/*----*\
|      |
| free |
|      |
\*----*/

const read_refs = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.i32$const, ...sleb128i32(types.Symbol.fields.refs.offset),
      wasm.i32$add,
      wasm.atomic$prefix,
      wasm.i32$atomic$load, 2, 0,
      wasm.i32$const, ...sleb128i32(0x1fffffff), // strip first three bits
      wasm.i32$and
    ];
  }
);

const free = pre_new_method(1, 0, 0, 0, 0, 0, { export: "free" }),
      free_indirect = add_to_func_table(free.func_idx);

// todo: will need in many other places (esp for maps that might not change)
const free_if_not_eq = funcs.build(
  [wasm.i32, wasm.i32], [], {},
  function (a, b) {
    return [
      wasm.local$get, ...a,
      wasm.local$get, ...b,
      wasm.i32$ne,
      wasm.if, wasm.void,
        wasm.local$get, ...a,
        wasm.call, ...free.uleb128,
      wasm.end,
    ];
  }
);

function impl_free (type, free_self) {
  return free.implement(type, function (val) {
    return [
      wasm.local$get, ...val,
      wasm.i32$const, ...sleb128i32(types.Symbol.fields.refs.offset),
      wasm.i32$add,
      wasm.i32$const, 1,
      wasm.atomic$prefix,
      // atomically subtract 1 from refs, returns previous value:
      wasm.i32$atomic$rmw$sub, 2, 0,
      // strip first three bits (used for local free)
      wasm.i32$const, ...sleb128i32(0x1fffffff),
      wasm.i32$and,
      wasm.i32$eqz,
      wasm.if, wasm.void,
        ...free_self.call(this, [
          wasm.local$get, ...val,
          wasm.i32$const, ...sleb128i32(type.size),
          wasm.call, ...free_mem.uleb128
        ]),
      wasm.end
    ];
  });
}

// value should never be freed:
const no_free = func => [];

free.implement(types.Nil, no_free);
free.implement(types.False, no_free);
free.implement(types.True, no_free);
//free.implement(types.Symbol, no_free);
free.implement(types.Keyword, no_free);
// todo: free these, but make sure global vars are protected
free.implement(types.Method, no_free);
free.implement(types.Type, no_free);

impl_free(types.Function, function (free_self) {
  return [
    wasm.local$get, 0,
    wasm.call, ...types.Function.fields.scope.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

impl_free(types.Function2, function (free_self) {
  return [
    wasm.local$get, 0,
    wasm.call, ...types.Function2.fields.scope.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

impl_free(types.Symbol, function (free_self) {
  return [
    wasm.local$get, 0,
    wasm.call, ...types.Symbol.fields.namespace.uleb128,
    wasm.call, ...free.uleb128,
    wasm.local$get, 0,
    wasm.call, ...types.Symbol.fields.name.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

// no type-specific cleanup, just use default:
impl_free(types.Int, (fm) => fm);
impl_free(types.Float, (fm) => fm);

// todo: impose max to prevent overflowing to flags
const inc_refs = pre_new_method(1, 0, 0, 1, 0, 0,
  { export: "inc_refs" },
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
// inc_refs.implement(types.Symbol, no_inc_refs);
inc_refs.implement(types.Keyword, no_inc_refs);
inc_refs.implement(types.Method, no_inc_refs);
inc_refs.implement(types.Type, no_inc_refs);

/*--------*\
|          |
| Function |
|          |
\*--------*/

const func_tbl_idx = pre_new_method(1, 0, 0, 1, 0, 0, {});

func_tbl_idx.implement(types.Function, types.Function.fields.tbl_idx.func_idx);
func_tbl_idx.implement(types.Function2, types.Function2.fields.tbl_idx.func_idx);

func_tbl_idx.implement(types.Method, function (mtd) {
  return [
    wasm.local$get, ...mtd,
    wasm.call, ...types.Method.fields.main_func.uleb128,
    wasm.call, ...func_tbl_idx.uleb128
  ];
});

/*------------*\
|              |
| coll methods |
|              |
\*------------*/

const get = pre_new_method(3, 0, 0, 1, 0, 0, { comp: "get" }),
      assoc = pre_new_method(3, 0, 0, 1, 0, 0, {
        export: "assoc", comp: "assoc"
      }),
      conj = pre_new_method( 2, 0, 0, 1, 0, 0, {
        export: "conj", comp: "conj"
      }),
      nth = pre_new_method(3, 0, 0, 1, 0, 0, {}),
      first = pre_new_method(1, 0, 0, 1, 0, 0, {}),
      rest = pre_new_method(1, 0, 0, 1, 0, 0, {}),
      count = pre_new_method(1, 0, 0, 1, 0, 0, {
        comp: "count",
        comp_wrapper: [wrap_result_i32_to_int]
      }),
      for_each = pre_new_method(6, 0, 0, 1, 0, 0, {}),
      to_seq = pre_new_method(1, 0, 0, 1, 0, 0, { comp: "to-seq" }),
      to_vec = pre_new_method(1, 0, 0, 1, 0, 0, { comp: "to-vec" });

const call_for_each = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (val, accum, idx, func) {
    const old_accum = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.local$get, ...accum,
      wasm.local$tee, ...old_accum,
      wasm.local$get, ...idx,
      wasm.i64$extend_i32_u,
      wasm.call, ...types.Int.constr.uleb128,
      wasm.local$tee, ...idx,
      wasm.local$get, ...func,
      wasm.local$get, ...func,
      wasm.call, ...func_tbl_idx.uleb128,
      wasm.call_indirect, ...sleb128i32(get_type_idx(4, 0, 0, 1, 0, 0)), 0,
      wasm.local$tee, ...accum,
      wasm.local$get, ...old_accum,
      wasm.i32$ne,
      wasm.if, wasm.void,
        wasm.local$get, ...old_accum,
        wasm.call, ...free.uleb128,
      wasm.end,
      wasm.local$get, ...idx,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...accum
    ];
  }
);

/*-----*\
|       |
| Array |
|       |
\*-----*/

// todo: check index against array length (in comp)
function array_getter (align, res_typ, load, exp) {
  if (!exp) exp = res_typ;
  return funcs.build(
    [wasm.i32, wasm.i32], [wasm[res_typ]],
    { export: `array_get_${exp}` },
    function (arr, idx) {
      return [
        wasm.local$get, ...arr,
        wasm.call, ...types.Array.fields.arr.uleb128,
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

const refs_array_get = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, idx) {
    return [
      wasm.local$get, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.local$get, ...idx,
      wasm.call, ...array_get_i32.uleb128
    ];
  }
);

// todo: check index against array length (in comp)
function array_setter (align, val_typ, nm, store) {
  return funcs.build(
    [wasm.i32, wasm.i32, wasm[val_typ]],
    [wasm.i32], { export: `array_set_${nm}` },
    function (arr, idx, val) {
      return [
        wasm.local$get, ...arr,
        wasm.call, ...types.Array.fields.arr.uleb128,
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

const refs_array_set_no_inc = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, idx, val) {
    return [
      // stage the return val before we overwrite the variable
      wasm.local$get, ...arr,
      wasm.local$get, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.local$tee, ...arr,
      wasm.local$get, ...idx,
      wasm.call, ...array_get_i32.uleb128,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...arr,
      wasm.local$get, ...idx,
      wasm.local$get, ...val,
      wasm.call, ...array_set_i32.uleb128,
      wasm.drop
    ];
  }
);

const refs_array_set = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, idx, val) {
    return [
      // stage the return val before we overwrite the variable
      wasm.local$get, ...arr,
      wasm.local$get, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.local$tee, ...arr,
      wasm.local$get, ...idx,
      wasm.call, ...array_get_i32.uleb128,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...arr,
      wasm.local$get, ...idx,
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.uleb128,
      wasm.call, ...array_set_i32.uleb128,
      wasm.drop
    ];
  }
);

// todo: test that len < arr.len (in comp)
const subarray = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, start, len) {
    return [
      wasm.local$get, ...arr,
      wasm.call, ...inc_refs.uleb128,
      wasm.call, ...types.Array.fields.arr.uleb128,
      wasm.local$get, ...start,
      wasm.i32$add,
      wasm.local$get, ...len,
      wasm.local$get, ...arr,
      wasm.call, ...types.Array.constr.uleb128
    ];
  }
);

impl_free(types.Array, function (free_self) {
  const arr = [0],
        mem = this.local(wasm.i32),
        idx = this.local(wasm.i32),
        len = this.local(wasm.i32),
        org = this.local(wasm.i32);
  return [
    // if this is a subarray:
    wasm.local$get, ...arr,
    wasm.call, ...types.Array.fields.original.uleb128,
    wasm.local$tee, ...org,
    wasm.if, wasm.void,
      wasm.local$get, ...org,
      wasm.call, ...free.uleb128,
    wasm.else,
      wasm.local$get, ...arr,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.i32$const, 2,
      wasm.i32$shl,
      wasm.local$tee, ...len,
      wasm.if, wasm.void,
        wasm.local$get, ...arr,
        wasm.call, ...types.Array.fields.arr.uleb128,
        wasm.local$set, ...mem,
        wasm.loop, wasm.void,
          // can only free in chunks of max_inst_size
          wasm.local$get, ...len,
          wasm.i32$const, ...sleb128i32(max_inst_size),
          wasm.i32$gt_u,
          wasm.if, wasm.void,
            wasm.local$get, ...mem,
            wasm.i32$const, ...sleb128i32(max_inst_size),
            wasm.call, ...free_mem.uleb128,
            wasm.local$get, ...mem,
            wasm.i32$const, ...sleb128i32(max_inst_size),
            wasm.i32$add,
            wasm.local$set, ...mem,
            wasm.local$get, ...len,
            wasm.i32$const, ...sleb128i32(max_inst_size),
            wasm.i32$sub,
            wasm.local$set, ...len,
            wasm.br, 1,
          wasm.else,
            wasm.local$get, ...len,
            wasm.if, wasm.void,
              wasm.local$get, ...mem,
              wasm.local$get, ...len,
              wasm.call, ...free_mem.uleb128,
            wasm.end,
          wasm.end,
        wasm.end,
      wasm.end,
    wasm.end,
    ...free_self
  ];
});

impl_free(types.RefsArray, function (free_self) {
  const arr = [0],
        inr = this.local(wasm.i32),
        idx = this.local(wasm.i32),
        cnt = this.local(wasm.i32);
  return [
    wasm.local$get, ...arr,
    wasm.call, ...types.RefsArray.fields.arr.uleb128,
    wasm.local$tee, ...inr,
    wasm.call, ...types.Array.fields.length.uleb128,
    wasm.local$tee, ...cnt,
    wasm.if, wasm.void,
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...inr,
          wasm.local$get, ...idx,
          wasm.call, ...array_get_i32.uleb128,
          wasm.call, ...free.uleb128,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...idx,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...inr,
      wasm.call, ...free.uleb128,
      ...free_self,
    wasm.end
  ];
});

const refs_array_for_each = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (arr, accum, idx, end_idx, accum_idx, func) {
    const len = this.local(wasm.i32),
          old_accum = this.local(wasm.i32);
    return [
      wasm.local$get, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$tee, ...len,
      wasm.local$get, ...end_idx,
      wasm.i32$lt_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...len,
      wasm.else,
        wasm.local$get, ...end_idx,
      wasm.end,
      wasm.local$tee, ...len,
      wasm.if, wasm.void,
        wasm.local$get, ...accum,
        wasm.local$tee, ...old_accum,
        wasm.call, ...inc_refs.uleb128,
        wasm.drop,
        wasm.loop, wasm.void,
          wasm.local$get, ...idx,
          wasm.local$get, ...len,
          wasm.i32$lt_u,
          wasm.if, wasm.void,
            wasm.local$get, ...arr,
            wasm.local$get, ...idx,
            wasm.call, ...refs_array_get.uleb128,
            wasm.local$get, ...accum,
            wasm.local$get, ...accum_idx,
            wasm.local$get, ...func,
            wasm.call, ...call_for_each.uleb128,
            wasm.local$set, ...accum,
            wasm.local$get, ...accum_idx,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...accum_idx,
            wasm.local$get, ...idx,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...idx,
            wasm.br, 1,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.local$get, ...old_accum,
      wasm.local$get, ...accum,
      wasm.i32$eq,
      wasm.if, wasm.void,
        wasm.local$get, ...old_accum,
        wasm.call, ...free.uleb128,
      wasm.end,
      wasm.local$get, ...accum
    ];
  }
);

for_each.implement(types.RefsArray,
  function (arr, accum, idx, end_idx, accum_idx, func) {
    return [
      wasm.local$get, ...arr,
      wasm.local$get, ...accum,
      wasm.local$get, ...idx,
      wasm.local$get, ...end_idx,
      wasm.local$get, ...accum_idx,
      wasm.local$get, ...func,
      wasm.call, ...refs_array_for_each.uleb128
    ];
  }
);

const array_by_length = funcs.build(
  [wasm.i32], [wasm.i32], { export: "array_by_length" },
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
          wasm.call, ...get_next_address.uleb128,
        wasm.else,
          // if <= max_inst_size, use alloc to get a free block as usual
          wasm.local$get, ...size,
          wasm.call, ...alloc.uleb128,
        wasm.end,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end,
      wasm.local$get, ...len,
      wasm.i32$const, 0,
      wasm.call, ...types.Array.constr.uleb128
    ];
  }
);

const refs_array_by_length = funcs.build(
  [wasm.i32], [wasm.i32], { export: "refs_array_by_length" },
  function (len) {
    return [
      wasm.local$get, ...len,
      wasm.call, ...array_by_length.uleb128,
      wasm.call, ...types.RefsArray.constr.uleb128
    ];
  }
);

const array_copy = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (src, i, dst, j, len) {
    return [
      wasm.local$get, ...dst,
      wasm.call, ...types.Array.fields.arr.uleb128,
      wasm.local$get, ...j,
      wasm.i32$add,
      wasm.local$get, ...src,
      wasm.call, ...types.Array.fields.arr.uleb128,
      wasm.local$get, ...i,
      wasm.i32$add,
      wasm.local$get, ...len,
      wasm.mem$prefix,
      wasm.mem$copy, 0, 0,
      wasm.local$get, ...dst
    ];
  }
);

const refs_array_copy = funcs.build(
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
          wasm.call, ...refs_array_get.uleb128,
          wasm.call, ...refs_array_set.uleb128,
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

const refs_array_fit = funcs.build(
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
      wasm.call, ...refs_array_by_length.uleb128
    ];
  }
);

const array_push_i32 = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (src, val) {
    const len = this.local(wasm.i32);
    return [
      wasm.local$get, ...src,
      wasm.i32$const, 0,
      wasm.local$get, ...src,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$tee, ...len,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.call, ...array_by_length.uleb128,
      wasm.i32$const, 0,
      wasm.local$get, ...len,
      wasm.i32$const, 2,
      wasm.i32$shl,
      wasm.call, ...array_copy.uleb128,
      wasm.local$get, ...len,
      wasm.local$get, ...val,
      wasm.call, ...array_set_i32.uleb128,
    ];
  }
);

const refs_array_fit_and_copy = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (src, idx) {
    const len = this.local(wasm.i32);
    return [
      wasm.local$get, ...src,
      wasm.i32$const, 0,
      wasm.local$get, ...src,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$tee, ...len,
      wasm.local$get, ...idx,
      wasm.call, ...refs_array_fit.uleb128,
      wasm.i32$const, 0,
      wasm.local$get, ...len,
      wasm.call, ...refs_array_copy.uleb128
    ];
  }
);

const refs_array_clone = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (src) {
    const len = this.local(wasm.i32);
    return [
      wasm.local$get, ...src,
      wasm.i32$const, 0,
      wasm.local$get, ...src,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$tee, ...len,
      wasm.call, ...refs_array_by_length.uleb128,
      wasm.i32$const, 0,
      wasm.local$get, ...len,
      wasm.call, ...refs_array_copy.uleb128
    ];
  }
);

compile();

funcs.build(
  [wasm.i32, wasm.i64], [wasm.i64],
  { comp: "array-get-i8" },
  function (arr, idx) {
    const idx32 = this.local(wasm.i32);
    return [
      wasm.local$get, ...idx,
      wasm.i32$wrap_i64,
      wasm.local$tee, ...idx32,
      wasm.local$get, ...arr,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.i32$const, 4,
      wasm.i32$mul,
      wasm.i32$lt_u,
      wasm.if, wasm.i64,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx32,
        wasm.call, ...array_get_i8.uleb128,
        wasm.i64$extend_i32_u,
      wasm.else,
        wasm.i32$const, 0,
        wasm.i32$const, ...sleb128i32(cached_string("array-get-i8")),
        wasm.call, ...types.Exception.constr.uleb128,
        wasm.throw, 0,
      wasm.end
    ];
  }
);

funcs.build(
  [wasm.i32, wasm.i64, wasm.i64], [wasm.i32], { comp: "array-set-i8" },
  function (arr, idx, num) {
    const idx32 = this.local(wasm.i32);
    return [
      wasm.local$get, ...idx,
      wasm.i32$wrap_i64,
      wasm.local$tee, ...idx32,
      wasm.local$get, ...arr,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.i32$lt_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx32,
        wasm.local$get, ...num,
        wasm.i32$wrap_i64,
        wasm.call, ...array_set_i8.uleb128,
      wasm.else,
        wasm.i32$const, 0,
        wasm.i32$const, ...sleb128i32(cached_string("array-set-i8")),
        wasm.call, ...types.Exception.constr.uleb128,
        wasm.throw, 0,
      wasm.end
    ];
  }
);
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

const swap_lock = funcs.build(
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

const swap_unlock = funcs.build(
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
    wasm.call, ...swap_lock.uleb128,
// todo: reinstate setters, use here
    wasm.local$get, ...atom,
    wasm.i32$const, 8,
    wasm.i32$add,
    wasm.local$tee, ...data,
    wasm.local$get, ...data,
    wasm.i32$load, 2, 0,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...val,
    wasm.call, ...inc_refs.uleb128,
    wasm.atomic$prefix,
    wasm.i32$atomic$store, 2, 0,
    wasm.local$get, ...mutex,
    wasm.call, ...swap_unlock.uleb128,
    wasm.local$get, ...val
  );
});
*/

const atom_swap_lock = funcs.build(
  [wasm.i32], [wasm.i32], { export: "atom_swap_lock" },
  function (atom) {
    return [
      // mutex
      wasm.local$get, ...atom,
      wasm.i32$const, ...sleb128i32(types.Atom.fields.mutex.offset),
      wasm.i32$add,
      wasm.call, ...swap_lock.uleb128,
      wasm.local$get, ...atom,
      wasm.call, ...types.Atom.fields.data.uleb128
    ];
  }
);

const atom_swap_unlock = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (atom) {
    return [
      // mutex
      wasm.local$get, ...atom,
      wasm.i32$const, ...sleb128i32(types.Atom.fields.mutex.offset),
      wasm.i32$add,
      wasm.call, ...swap_unlock.uleb128,
      wasm.i32$const, 1
    ];
  }
);

// called when atom is already locked
const atom_swap_set = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { export: "atom_swap_set" },
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
      wasm.call, ...free.uleb128,
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.uleb128,
      wasm.atomic$prefix,
      wasm.i32$atomic$store, 2, 0,
      wasm.local$get, ...atom,
      wasm.i32$const, ...sleb128i32(types.Atom.fields.mutex.offset),
      wasm.i32$add,
      wasm.call, ...swap_unlock.uleb128,
      wasm.local$get, ...val
    ];
  }
);

const atom_deref = funcs.build(
  [wasm.i32], [wasm.i32], { comp: "deref" },
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
    wasm.call, ...start_thread.uleb128,
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

impl_free(types.Atom, function (free_self) {
  const atom = [0];
  return [
    wasm.local$get, ...atom,
    wasm.call, ...types.Atom.fields.data.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

/*----------*\
|            |
| TaggedData |
|            |
\*----------*/

impl_free(types.TaggedData, function (free_self) {
  const td = [0];
  return [
    wasm.local$get, ...td,
    wasm.call, ...types.TaggedData.fields.tag.uleb128,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...td,
    wasm.call, ...types.TaggedData.fields.data.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

/*--------*\
|          |
| Metadata |
|          |
\*--------*/

impl_free(types.Metadata, function (free_self) {
  const md = [0];
  return [
    wasm.local$get, ...md,
    wasm.call, ...types.Metadata.fields.meta.uleb128,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...md,
    wasm.call, ...types.Metadata.fields.data.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

/*----*\
|      |
| math |
|      |
\*----*/

const safe_add_i32 = funcs.build(
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
        wasm.call, ...types.Exception.constr.uleb128,
        wasm.throw, 0,
      wasm.end
    ];
  }
);

const is_odd_i64 = funcs.build(
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
const pow = funcs.build(
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
              wasm.call, ...is_odd_i64.uleb128,
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

const i64_to_string = funcs.build(
  [wasm.i64], [wasm.i32], { comp: "i64->string" },
  function (num) {
    const arr = this.local(wasm.i32),
          len = this.local(wasm.i32),
          idx = this.local(wasm.i32);
    return [
      wasm.i32$const, 0,
      wasm.call, ...array_by_length.uleb128,
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
        wasm.call, ...i32_div_ceil.uleb128,
        wasm.call, ...array_by_length.uleb128,
        wasm.local$tee, ...arr,
        wasm.i32$const, 1,
        wasm.local$get, ...idx,
        wasm.call, ...array_copy.uleb128,
        wasm.i32$const, 0,
        wasm.local$get, ...num,
        wasm.i64$const, 10,
        wasm.i64$rem_u,
        wasm.i32$wrap_i64,
        wasm.i32$const, ...sleb128i32(48),
        wasm.i32$add,
        wasm.call, ...array_set_i8.uleb128,
        wasm.local$set, ...arr,
        wasm.call, ...free.uleb128,
        wasm.local$get, ...num,
        wasm.i64$const, 10,
        wasm.i64$div_u,
        wasm.local$tee, ...num,
        wasm.i32$wrap_i64,
        wasm.br_if, 0,
      wasm.end,
      wasm.local$get, ...arr,
      wasm.local$get, ...len,
      wasm.call, ...types.String.constr.uleb128
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
    wasm.call, ...types.Int.constr.uleb128
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
        wasm.i32$const, nil,
      wasm.else,
        wasm.i32$const, ...sleb128i32(comp_true),
      wasm.end,
    wasm.else,
      wasm.i32$const, nil,
    wasm.end
  ];
}

function wrap_args_int_to_i32 (idxs) {
  return function (func, next) {
    const code = [];
    for (let i = 0; i < idxs.length; i++) {
      code.push(
        wasm.local$get, idxs[i],
        wasm.call, ...types.Int.fields.value.uleb128,
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

impl_free(types.String, function (free_self) {
  const str = [0];
  return [
    wasm.local$get, ...str,
    wasm.call, ...types.String.fields.arr.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

impl_free(types.File, function (free_self) {
  const file = [0];
  return [
    wasm.local$get, ...file,
    wasm.call, ...file_close.uleb128,
    ...free_self
  ];
});

impl_free(types.FileSlice, function (free_self) {
  return [
    wasm.local$get, 0,
    wasm.call, ...types.FileSlice.fields.file.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

const is_string_like = pre_new_method(
  1, 0, 0, 1, 0, 0, {}, () => [wasm.i32$const, 0]
);

is_string_like.implement(types.String, () => [wasm.i32$const, 1]);
is_string_like.implement(types.FileSlice, () => [wasm.i32$const, 1]);

const empty_string = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (len) {
    return [
      wasm.local$get, ...len,
      wasm.i32$const, 4,
      wasm.call, ...i32_div_ceil.uleb128,
      wasm.call, ...array_by_length.uleb128,
      wasm.local$get, ...len,
      wasm.call, ...types.String.constr.uleb128,
    ];
  }
);

const force_to_string = pre_new_method(1, 0, 0, 1, 0, 0, {
  comp: "force-to-string"
});

force_to_string.implement(types.FileSlice, function (fsl) {
  const len = this.local(wasm.i32);
  return [
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.file.uleb128,
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.length.uleb128,
    wasm.local$tee, ...len,
    wasm.call, ...empty_string.uleb128,
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.start.uleb128,
    wasm.local$get, ...len,
    wasm.call, ...file_get_string_chunk.uleb128
  ];
});

force_to_string.implement(types.String, function (str) {
  return [
    wasm.local$get, ...str
  ];
});

const substring = pre_new_method(
  3, 0, 0, 1, 0, 0, {
    comp: "substring",
    comp_wrapper: [wrap_args_int_to_i32([1, 2])]
  }
);

// todo: test that len < str.len
substring.implement(types.String, function (str, start, len) {
  return [
    wasm.local$get, ...str,
    wasm.call, ...types.String.fields.arr.uleb128,
    wasm.local$get, ...start,
    wasm.i32$const, ...len,
    wasm.i32$const, 4,
    wasm.call, ...i32_div_ceil.uleb128,
    wasm.call, ...subarray.uleb128,
    wasm.local$get, ...len,
    wasm.call, ...types.String.constr.uleb128
  ];
});

substring.implement(types.FileSlice, function (fsl, start, len) {
  return [
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.file.uleb128,
    wasm.call, ...inc_refs.uleb128,
    wasm.local$get, ...start,
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.start.uleb128,
    wasm.i32$add,
    wasm.local$get, ...len,
    wasm.call, ...types.FileSlice.constr.uleb128
  ];
});

const substring_to_end = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32],
  {
    comp: "substring-to-end",
    comp_wrapper: [wrap_args_int_to_i32([1])],
  },
  function (str, idx) {
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.local$get, ...str,
      wasm.call, ...count.uleb128,
      wasm.local$get, ...idx,
      wasm.i32$sub,
      wasm.call, ...substring.uleb128
    ];
  }
);

// todo: test that end < start
const substring_until = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32],
  {
    comp: "substring-until",
    comp_wrapper: [wrap_args_int_to_i32([1, 2])]
  },
  function (str, start, end) {
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...start,
      wasm.local$get, ...end,
      wasm.local$get, ...start,
      wasm.i32$sub,
      wasm.call, ...substring.uleb128
    ];
  }
);

const get_string_byte = pre_new_method(2, 0, 0, 1, 0, 0, {});

get_string_byte.implement(types.String, function (str, idx) {
  return [
    wasm.local$get, ...str,
    wasm.call, ...types.String.fields.arr.uleb128,
    wasm.local$get, ...idx,
    wasm.call, ...array_get_i8.uleb128,
  ];
});

get_string_byte.implement(types.FileSlice, function (fsl, idx) {
  return [
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.file.uleb128,
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.start.uleb128,
    wasm.local$get, ...idx,
    wasm.i32$add,
    wasm.call, ...file_read_byte.uleb128,
  ];
});

const get_string_i32 = pre_new_method(2, 0, 0, 1, 0, 0, {});

get_string_i32.implement(types.String, function (str, idx) {
  return [
    wasm.local$get, ...str,
    wasm.call, ...types.String.fields.arr.uleb128,
    wasm.local$get, ...idx,
    wasm.call, ...array_get_i32.uleb128,
  ];
});

get_string_i32.implement(types.FileSlice, function (fsl, idx) {
  return [
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.file.uleb128,
    wasm.local$get, ...idx,
    wasm.i32$const, 2,
    wasm.i32$shl,
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.start.uleb128,
    wasm.i32$add,
    wasm.call, ...file_read_i32.uleb128,
  ];
});

const get_string_i64 = pre_new_method(2, 0, 0, 0, 1, 0, {});

get_string_i64.implement(types.String, function (str, idx) {
  return [
    wasm.local$get, ...str,
    wasm.call, ...types.String.fields.arr.uleb128,
    wasm.local$get, ...idx,
    wasm.call, ...array_get_i64.uleb128
  ];
});

get_string_i64.implement(types.FileSlice, function (fsl, idx) {
  return [
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.file.uleb128,
    wasm.local$get, ...idx,
    wasm.i32$const, 3,
    wasm.i32$shl,
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.start.uleb128,
    wasm.i32$add,
    wasm.call, ...file_read_i64.uleb128,
  ];
});

const get_codepoint = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32, wasm.i32], {},
  function (str, idx) {
    const org = this.local(wasm.i32),
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
      wasm.call, ...count.uleb128,
      wasm.local$tee, ...len,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...get_string_byte.uleb128,
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
                wasm.local$get, ...str,
                wasm.local$get, ...idx,
                wasm.i32$const, 1,
                wasm.i32$add,
                wasm.local$tee, ...idx,
                wasm.call, ...get_string_byte.uleb128,
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
      wasm.local$get, ...chr,
      wasm.local$get, ...idx,
    ];
  }
);

count.implement(types.FileSlice, function (fsl) {
  return [
    wasm.local$get, ...fsl,
    wasm.call, ...types.FileSlice.fields.length.uleb128
  ];
});

count.implement(types.String, function (str) {
  return [
    wasm.local$get, ...str,
    wasm.call, ...types.String.fields.length.uleb128
  ];
});

// todo: change to function, use methods internally
const index_of_codepoint = pre_new_method(
  2, 0, 0, 1, 0, 0, {
    comp: "index-of-codepoint",
    comp_wrapper: [
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
    wasm.call, ...count.uleb128,
    wasm.local$set, ...len,
    wasm.loop, wasm.void,
      wasm.local$get, ...idx,
      wasm.local$get, ...len,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...get_codepoint.uleb128,
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

const copy_string = pre_new_method(4, 0, 0, 0, 0, 0, {});

copy_string.implement(types.String, function (src, dst, off, len) {
  return [
    wasm.local$get, ...dst,
    wasm.call, ...types.String.fields.arr.uleb128,
    wasm.call, ...types.Array.fields.arr.uleb128,
    wasm.local$get, ...off,
    wasm.i32$add,
    wasm.local$get, ...src,
    wasm.call, ...types.String.fields.arr.uleb128,
    wasm.call, ...types.Array.fields.arr.uleb128,
    wasm.local$get, ...len,
    wasm.mem$prefix,
    wasm.mem$copy, 0, 0,
  ];
});

copy_string.implement(types.FileSlice, function (src, dst, off, len) {
  return [
    wasm.local$get, ...src,
    wasm.call, ...types.FileSlice.fields.file.uleb128,
    wasm.local$get, ...dst,
    wasm.local$get, ...off,
    wasm.local$get, ...src,
    wasm.call, ...types.FileSlice.fields.start.uleb128,
    wasm.i32$add,
    wasm.local$get, ...len,
    wasm.call, ...file_get_string_chunk.uleb128,
    wasm.drop
  ];
});

// todo: confirm str2 is string
const concat_str = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { comp: "concat-str" },
  function (str1, str2) {
    const len1 = this.local(wasm.i32),
          len2 = this.local(wasm.i32),
          arr = this.local(wasm.i32),
          out = this.local(wasm.i32);
    return [
      wasm.local$get, ...str1,
      wasm.call, ...count.uleb128,
      wasm.local$tee, ...len1,
      wasm.local$get, ...str2,
      //wasm.call, ...force_to_string.uleb128,
      //wasm.local$tee, ...str2,
      wasm.call, ...count.uleb128,
      wasm.local$tee, ...len2,
      wasm.call, ...safe_add_i32.uleb128,
      wasm.call, ...empty_string.uleb128,
      wasm.local$set, ...out,
      wasm.local$get, ...str1,
      wasm.local$get, ...out,
      wasm.i32$const, 0,
      wasm.local$get, ...len1,
      wasm.call, ...copy_string.uleb128,
      wasm.local$get, ...str2,
      wasm.local$get, ...out,
      wasm.local$get, ...len1,
      wasm.local$get, ...len2,
      wasm.call, ...copy_string.uleb128,
      wasm.local$get, ...out
    ];
  }
);

/*------*\
|        |
| Object |
|        |
\*------*/

impl_free(types.Object, function (free_self) {
  const obj = [0];
  return [
    wasm.local$get, ...obj,
    wasm.call, ...types.Object.fields.address.uleb128,
    wasm.call, ...free_ref.uleb128,
    ...free_self
  ];
});

/*------*\
|        |
| Vector |
|        |
\*------*/

const empty_vector = comp.Vector(0, 5, empty_refs_array, empty_refs_array);
      
impl_free(types.Vector, function (free_self) {
  const vec = [0];
  return [
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.count.uleb128,
    wasm.if, wasm.void,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.root.uleb128,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.tail.uleb128,
      wasm.call, ...free.uleb128,
      ...free_self,
    wasm.end
  ];
});

const new_path = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (level, node) {
    return [
      // new_path is called when a new vector is being created
      // the tail (node) will now be referenced by two vectors
      wasm.local$get, ...node,
      wasm.call, ...inc_refs.uleb128,
      wasm.drop,
      wasm.loop, wasm.i32,
        wasm.local$get, ...level,
        wasm.if, wasm.i32,
          wasm.i32$const, 1,
          wasm.call, ...refs_array_by_length.uleb128,
          wasm.i32$const, 0,
          wasm.local$get, ...node,
          // new nodes are only referenced here so don't need inc_refs
          wasm.call, ...refs_array_set_no_inc.uleb128,
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

const push_tail = funcs.build(
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
      wasm.call, ...types.Vector.fields.count.uleb128,
      wasm.i32$const, 1,
      wasm.i32$sub,
      wasm.local$get, ...level,
      wasm.i32$shr_u,
      wasm.i32$const, 31,
      wasm.i32$and,
      wasm.local$tee, ...subidx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.call, ...refs_array_by_length.uleb128,
  
      // last two args to refs_array_copy
      wasm.i32$const, 0,
      wasm.local$get, ...parent,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
  
      // inc_refs because contents will be shared
      wasm.call, ...refs_array_copy.uleb128,
      wasm.local$tee, ...arr,
  
      // second arg to refs_array_set_no_inc
      wasm.local$get, ...subidx,
  
      wasm.i32$const, 5,
      wasm.local$get, ...level,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...tail,
        // tail is now shared
        wasm.call, ...inc_refs.uleb128,
      wasm.else,
        wasm.local$get, ...level,
        wasm.i32$const, 5,
        wasm.i32$sub,
        wasm.local$set, ...level,
        wasm.local$get, ...arr,
        wasm.local$get, ...subidx,
        wasm.call, ...refs_array_get.uleb128,
        wasm.local$tee, ...child,
        wasm.if, wasm.i32,
          wasm.local$get, ...vec,
          wasm.local$get, ...level,
          wasm.local$get, ...child,
          wasm.local$get, ...tail,
          // no inc_refs because func returns new array
          // contents of new array are inc_ref'd above
          wasm.call, ...this.uleb128,
        wasm.else,
          wasm.local$get, ...level,
          wasm.local$get, ...tail,
          // tail is inc_ref'd inside new_path
          wasm.call, ...new_path.uleb128,
        wasm.end,
      wasm.end,
      wasm.call, ...refs_array_set_no_inc.uleb128
    ];
  }
);

const tail_off = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (vec) {
    const cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.count.uleb128,
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
    wasm.call, ...types.Vector.fields.tail.uleb128,
    wasm.local$set, ...tail,
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.shift.uleb128,
    wasm.local$set, ...shift,
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.root.uleb128,
    wasm.local$set, ...root,
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.count.uleb128,
    wasm.local$tee, ...cnt,
    wasm.local$get, ...vec,
    wasm.call, ...tail_off.uleb128,
    wasm.i32$sub,
    wasm.i32$const, 32,
    wasm.i32$lt_u,
    wasm.if, wasm.void,
      // tail is not full, so just put val there
      wasm.local$get, ...tail,
      wasm.i32$const, 0,
      wasm.local$get, ...tail,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$tee, ...len,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.call, ...refs_array_by_length.uleb128,
      wasm.i32$const, 0,
      wasm.local$get, ...len,
      // inc_refs needed for shared contents of tails
      wasm.call, ...refs_array_copy.uleb128,
      wasm.local$get, ...len,
      wasm.local$get, ...val,
      wasm.call, ...refs_array_set.uleb128,
      wasm.local$set, ...tail,
      // root is unchanged, so it will be shared
      wasm.local$get, ...root,
      wasm.call, ...inc_refs.uleb128,
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
        wasm.call, ...refs_array_by_length.uleb128,
        wasm.i32$const, 0,
        wasm.local$get, ...root,
        // root is now shared, so inc_refs needed
        wasm.call, ...refs_array_set.uleb128,
        wasm.i32$const, 1,
        wasm.local$get, ...shift,
        wasm.local$get, ...tail,
        // tail is inc_ref'd in new_path
        wasm.call, ...new_path.uleb128,
        // new_path is new, so no inc_refs
        wasm.call, ...refs_array_set_no_inc.uleb128,
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
        wasm.call, ...push_tail.uleb128,
        wasm.local$set, ...root,
      wasm.end,
      wasm.i32$const, 1,
      wasm.call, ...refs_array_by_length.uleb128,
      wasm.i32$const, 0,
      wasm.local$get, ...val,
      wasm.call, ...refs_array_set.uleb128,
      wasm.local$set, ...tail,
    wasm.end,
    wasm.local$get, ...cnt,
    wasm.i32$const, 1,
    wasm.i32$add,
    wasm.local$get, ...shift,
    wasm.local$get, ...root,
    wasm.local$get, ...tail,
    wasm.call, ...types.Vector.constr.uleb128
  ];
});

const unchecked_array_for = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (vec, n) {
    const node = this.local(wasm.i32),
          level = this.local(wasm.i32);
    return [
      wasm.local$get, ...n,
      wasm.local$get, ...vec,
      wasm.call, ...tail_off.uleb128,
      wasm.i32$ge_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.tail.uleb128,
      wasm.else,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.root.uleb128,
        wasm.local$set, ...node,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.shift.uleb128,
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
            wasm.call, ...refs_array_get.uleb128,
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
    wasm.call, ...types.Vector.fields.count.uleb128,
    wasm.i32$lt_u,
    wasm.if, wasm.i32,
      wasm.local$get, ...vec,
      wasm.local$get, ...n,
      wasm.call, ...unchecked_array_for.uleb128,
      wasm.local$get, ...n,
      wasm.i32$const, ...sleb128i32(0x01f),
      wasm.i32$and,
      wasm.call, ...refs_array_get.uleb128,
    wasm.else,
      wasm.local$get, ...not_found,
    wasm.end
  ];
});

const do_assoc = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (vec, level, node, idx, val) {
    const subidx = this.local(wasm.i32);
    return [
      wasm.local$get, ...node,
      // inc_refs for shared contents of arrays
      wasm.call, ...refs_array_clone.uleb128,
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
        wasm.call, ...refs_array_get.uleb128,
        wasm.local$get, ...idx,
        wasm.local$get, ...val,
        wasm.call, ...this.uleb128,
  
        // recursively created node is new, so no inc_refs
        wasm.call, ...refs_array_set_no_inc.uleb128,
      wasm.else,
        wasm.local$get, ...node,
        wasm.local$get, ...idx,
        wasm.i32$const, ...sleb128i32(0x01f),
        wasm.i32$and,
        wasm.local$get, ...val,
        wasm.call, ...refs_array_set.uleb128,
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
    wasm.call, ...types.Vector.fields.count.uleb128,
    wasm.local$tee, ...cnt,
    wasm.local$get, ...n,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...vec,
      wasm.local$get, ...val,
      wasm.call, ...conj.uleb128,
    wasm.else,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.shift.uleb128,
      wasm.local$set, ...shift,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.root.uleb128,
      wasm.local$set, ...root,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.tail.uleb128,
      wasm.local$set, ...tail,
      wasm.local$get, ...vec,
      wasm.call, ...tail_off.uleb128,
      wasm.local$get, ...n,
      wasm.i32$le_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...cnt,
        wasm.local$get, ...shift,
        wasm.local$get, ...root,
        // root is now shared
        wasm.call, ...inc_refs.uleb128,
        wasm.local$get, ...tail,
        wasm.call, ...refs_array_clone.uleb128,
        wasm.local$get, ...n,
        wasm.i32$const, ...sleb128i32(0x01f),
        wasm.i32$and,
        wasm.local$get, ...val,
        wasm.call, ...refs_array_set.uleb128,
        wasm.call, ...types.Vector.constr.uleb128,
      wasm.else,
        wasm.local$get, ...cnt,
        wasm.local$get, ...shift,
        wasm.local$get, ...vec,
        wasm.local$get, ...shift,
        wasm.local$get, ...root,
        wasm.local$get, ...n,
        wasm.local$get, ...val,
        wasm.call, ...do_assoc.uleb128,
        wasm.local$get, ...tail,
        // tail is now shared
        wasm.call, ...inc_refs.uleb128,
        wasm.call, ...types.Vector.constr.uleb128,
      wasm.end,
    wasm.end
  ];
});

count.implement(types.Vector, function (vec) {
  return [
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.count.uleb128
  ];
});

to_vec.implement(types.Vector, vec => [wasm.local$get, ...vec]);

const vec_node_for_each = funcs.build(
  [
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32
  ],
  [wasm.i32], {},
// todo: use end_idx
  function (vec, node, accum, n, end_idx, accum_idx, shift, func) {
    const idx = this.local(wasm.i32),
          end_n = this.local(wasm.i32),
          len = this.local(wasm.i32),
          shift2 = this.local(wasm.i32),
          tail_start = this.local(wasm.i32),
          entry = this.local(wasm.i32),
          old_accum = this.local(wasm.i32);
    return [
      wasm.local$get, ...node,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$tee, ...len,
      wasm.local$get, ...end_idx,
      wasm.local$get, ...shift,
      wasm.i32$shr_u,
      wasm.i32$const, 31,
      wasm.i32$and,
      wasm.local$tee, ...end_n,
      wasm.i32$lt_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...len,
      wasm.else,
        wasm.local$get, ...end_n,
      wasm.end,
      wasm.local$tee, ...len,
      wasm.if, wasm.void,
        wasm.local$get, ...accum,
        wasm.local$tee, ...old_accum,
        wasm.call, ...inc_refs.uleb128,
        wasm.drop,
        wasm.local$get, ...n,
        wasm.local$get, ...shift,
        wasm.i32$shr_u,
        wasm.i32$const, 31,
        wasm.i32$and,
        wasm.local$set, ...idx,
        wasm.local$get, ...shift,
        wasm.i32$const, 5,
        wasm.i32$sub,
        wasm.local$set, ...shift2,
        wasm.loop, wasm.void,
          wasm.local$get, ...idx,
          wasm.local$get, ...len,
          wasm.i32$lt_u,
          wasm.if, wasm.void,
            wasm.local$get, ...node,
            wasm.local$get, ...idx,
            wasm.call, ...refs_array_get.uleb128,
            wasm.local$set, ...entry,
            wasm.local$get, ...shift2,
            wasm.if, wasm.void,
              wasm.i32$const, nil,
              wasm.local$get, ...entry,
              wasm.local$get, ...accum,
              wasm.local$get, ...n,
              wasm.local$get, ...end_idx,
              wasm.local$get, ...accum_idx,
              wasm.local$get, ...shift2,
              wasm.local$get, ...func,
              wasm.call, ...this.uleb128,
              wasm.drop,
            wasm.else,
              wasm.local$get, ...entry,
              wasm.local$get, ...accum,
              wasm.local$get, ...accum_idx,
              wasm.local$get, ...func,
              wasm.call, ...call_for_each.uleb128,
              wasm.local$set, ...accum,
            wasm.end,
            wasm.local$get, ...n,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...n,
            wasm.local$get, ...accum_idx,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...accum_idx,
            wasm.local$get, ...idx,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...idx,
            wasm.br, 1,
          wasm.end,
        wasm.end,
        wasm.local$get, ...old_accum,
        wasm.local$get, ...accum,
        wasm.i32$eq,
        wasm.if, wasm.void,
          wasm.local$get, ...old_accum,
          wasm.call, ...free.uleb128,
        wasm.end,
      wasm.end,
      wasm.local$get, ...vec,
      wasm.if, wasm.void,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.tail.uleb128,
        wasm.local$get, ...accum,
        wasm.local$get, ...vec,
        wasm.call, ...tail_off.uleb128,
        wasm.local$tee, ...tail_start,
        wasm.local$get, ...n,
        wasm.i32$lt_u,
        wasm.if, wasm.i32,
          wasm.local$get, ...n,
        wasm.else,
          wasm.local$get, ...tail_start,
        wasm.end,
        wasm.i32$const, 31,
        wasm.i32$and,
	wasm.local$get, ...end_idx,
        wasm.local$get, ...accum_idx,
        wasm.local$get, ...func,
        wasm.call, ...refs_array_for_each.uleb128,
        wasm.local$set, ...accum,
      wasm.end,
      wasm.local$get, ...accum
    ];
  }
);

// todo: do more efficiently
for_each.implement(types.Vector,
  function (vec, accum, idx, end_idx, accum_idx, func) {
    const n = this.local(wasm.i32),
          cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...vec,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.root.uleb128,
      wasm.local$get, ...accum,
      wasm.local$get, ...idx,
      wasm.local$get, ...end_idx,
      wasm.local$get, ...accum_idx,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.shift.uleb128,
      wasm.local$get, ...func,
      wasm.call, ...vec_node_for_each.uleb128
    ];
  }
);

const vector_from_array = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (arr) {
    const cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$tee, ...cnt,
      wasm.i32$const, 32,
      wasm.i32$le_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...cnt,
        wasm.i32$const, 5,
        wasm.i32$const, ...sleb128i32(empty_refs_array),
        wasm.local$get, ...arr,
        wasm.call, ...inc_refs.uleb128,
        wasm.call, ...types.Vector.constr.uleb128,
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

const m3_mix_k = funcs.build(
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

const m3_mix_h = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (h, k) {
    return [
      wasm.local$get, ...h,
      wasm.local$get, ...k,
      wasm.call, ...m3_mix_k.uleb128,
      wasm.i32$const, 13,
      wasm.i32$rotl,
      wasm.i32$const, 5,
      wasm.i32$mul,
      wasm.i32$const, ...sleb128i32(0xe6546b64),
      wasm.i32$add
    ];
  }
);

const m3_fmix = funcs.build(
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

const hash_bytes = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (str, len) {
    const cnt = this.local(wasm.i32),
          idx = this.local(wasm.i32),
          hsh = this.local(wasm.i32),
          rem = this.local(wasm.i32);
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
          wasm.local$get, ...str,
          wasm.local$get, ...idx,
          wasm.call, ...get_string_i32.uleb128,
          wasm.call, ...m3_mix_h.uleb128,
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
      wasm.local$tee, ...rem,
      wasm.if, wasm.void,
        wasm.local$get, ...hsh,
        wasm.local$get, ...str,
        wasm.local$get, ...cnt,
        wasm.call, ...get_string_i32.uleb128,
        wasm.local$get, ...rem,
        wasm.i32$const, 1,
        wasm.i32$eq,
        wasm.if, wasm.i32,
          wasm.i32$const, ...sleb128i32(2**8-1),
        wasm.else,
          wasm.local$get, ...rem,
          wasm.i32$const, 2,
          wasm.i32$eq,
          wasm.if, wasm.i32,
            wasm.i32$const, ...sleb128i32(2**16-1),
          wasm.else,
            wasm.i32$const, ...sleb128i32(2**24-1),
          wasm.end,
        wasm.end,
        wasm.i32$and,
        wasm.call, ...m3_mix_k.uleb128,
        wasm.local$set, ...hsh,
      wasm.end,
      wasm.local$get, ...hsh,
      wasm.local$get, ...len,
      wasm.call, ...m3_fmix.uleb128
    ];
  }
);

const hash_id = function (val) {
  return [wasm.local$get, ...val];
}

const hash = pre_new_method(1, 0, 0, 1, 0, 0, {
  comp: "hash",
  export: "hash",
  comp_wrapper: [wrap_result_i32_to_int]
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
    wasm.call, ...types.Int.fields.value.uleb128,
    wasm.i32$wrap_i64
  ];
});

hash.implement(types.Float, function (f) {
  return [
    wasm.local$get, ...f,
    wasm.call, ...types.Float.fields.value.uleb128,
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
      wasm.end,
      wasm.local$tee, ...h,
    ];
  };
}

const hash_string = caching_hash(
  wasm.local$get, 0,
  wasm.local$get, 0,
  wasm.call, ...count.uleb128,
  wasm.call, ...hash_bytes.uleb128
);

hash.implement(types.String, hash_string);
hash.implement(types.FileSlice, hash_string);

// based on how Scala handles Tuple2
function impl_hash_symkw (which) {
  hash.implement(which, caching_hash(
    wasm.i32$const, 0,
    wasm.i32$const, ...sleb128i32(which.type_num),
    wasm.call, ...m3_mix_h.uleb128,
    wasm.local$get, 0,
    wasm.call, ...which.fields.namespace.uleb128,
    wasm.call, ...hash.uleb128,
    wasm.call, ...m3_mix_h.uleb128,
    wasm.local$get, 0,
    wasm.call, ...which.fields.name.uleb128,
    wasm.call, ...hash.uleb128,
    wasm.call, ...m3_mix_h.uleb128,
    wasm.i32$const, 2,
    wasm.call, ...m3_fmix.uleb128
  ));
}

impl_hash_symkw(types.Symbol);
impl_hash_symkw(types.Keyword);

/*--*\
|    |
| eq |
|    |
\*--*/

const equiv = pre_new_method(2, 0, 0, 1, 0, 0, {}, () => [wasm.i32$const, 0]);

const string_matches = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (str1, str2) {
    const len = this.local(wasm.i32),
          idx = this.local(wasm.i32),
          cnt = this.local(wasm.i32),
          out = this.local(wasm.i32);
    return [
      wasm.local$get, ...str1,
      wasm.call, ...count.uleb128,
      wasm.local$get, ...str2,
      wasm.call, ...count.uleb128,
      wasm.local$tee, ...len,
      wasm.i32$ge_u,
      wasm.if, wasm.void,
        wasm.local$get, ...len,
        // divide by 8 because len is in bytes, but we will compare i64s
        wasm.i32$const, 3,
        wasm.i32$shr_u,
        wasm.local$set, ...cnt,
        wasm.i32$const, 1,
        wasm.local$set, ...out,
        wasm.loop, wasm.void,
          wasm.local$get, ...idx,
          wasm.local$get, ...cnt,
          wasm.i32$lt_u,
          wasm.if, wasm.void,
            wasm.local$get, ...str1,
            wasm.local$get, ...idx,
            wasm.call, ...get_string_i64.uleb128,
            wasm.local$get, ...str2,
            wasm.local$get, ...idx,
            wasm.call, ...get_string_i64.uleb128,
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
              wasm.call, ...get_string_byte.uleb128,
              wasm.local$get, ...str2,
              wasm.local$get, ...idx,
              wasm.call, ...get_string_byte.uleb128,
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
      wasm.end,
      wasm.local$get, ...out
    ];
  }
);

const string_matches_at = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {
    comp: "string-matches-at",
    comp_wrapper: [
      wrap_args_int_to_i32([2]),
      wrap_result_i32_to_bool
    ]
  },
  function (str, sbstr, from) {
    const len = this.local(wasm.i32);
    return [
      wasm.local$get, ...str,
      wasm.call, ...count.uleb128,
      wasm.local$get, ...from,
      wasm.i32$sub,
      wasm.local$get, ...sbstr,
      wasm.call, ...count.uleb128,
      wasm.local$tee, ...len,
      wasm.i32$ge_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...str,
        wasm.local$get, ...from,
        wasm.local$get, ...len,
        wasm.call, ...substring.uleb128,
        wasm.local$tee, ...str,
        wasm.local$get, ...sbstr,
        wasm.i32$const, 0,
        wasm.local$get, ...len,
        wasm.call, ...substring.uleb128,
        wasm.local$tee, ...sbstr,
        wasm.call, ...string_matches.uleb128,
        wasm.local$get, ...sbstr,
        wasm.call, ...free.uleb128,
        wasm.local$get, ...str,
        wasm.call, ...free.uleb128,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  }
);

const string_equiv = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (a, b) {
    const len = this.local(wasm.i32);
    return [
      wasm.local$get, ...b,
      wasm.call, ...is_string_like.uleb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...a,
        wasm.call, ...count.uleb128,
        wasm.local$tee, ...len,
        wasm.local$get, ...b,
        wasm.call, ...count.uleb128,
        wasm.i32$eq,
        wasm.if, wasm.i32,
          wasm.local$get, ...a,
          wasm.i32$const, 0,
          wasm.local$get, ...len,
          wasm.call, ...substring.uleb128,
          wasm.local$tee, ...a,
          wasm.local$get, ...b,
          wasm.i32$const, 0,
          wasm.local$get, ...len,
          wasm.call, ...substring.uleb128,
          wasm.local$tee, ...b,
          wasm.call, ...string_matches.uleb128,
          wasm.local$get, ...a,
          wasm.call, ...free.uleb128,
          wasm.local$get, ...b,
          wasm.call, ...free.uleb128,
        wasm.else,
          wasm.i32$const, 0,
        wasm.end,
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
        wasm.call, ...equiv.uleb128,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  };
}

equiv.implement(types.String, hashed_equiv(string_equiv));
equiv.implement(types.FileSlice, hashed_equiv(string_equiv));

function equiv_by_field(type, field, op) {
  equiv.implement(type, function (a, b) {
    return [
      wasm.local$get, ...a,
      wasm.call, ...type.fields[field].uleb128,
      wasm.local$get, ...b,
      wasm.call, ...type.fields[field].uleb128,
      op
    ];
  });
}

equiv_by_field(types.Int, "value", wasm.i64$eq);
equiv_by_field(types.Float, "value", wasm.f64$eq);

const eq = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {
    comp: "eq",
    comp_wrapper: [wrap_result_i32_to_bool]
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
        wasm.call, ...equiv.uleb128,
      wasm.end
    ];
  }
);

// todo: hashed equiv
equiv.implement(types.Symbol, function (a, b) {
  return [
    wasm.local$get, ...a,
    wasm.call, ...types.Symbol.fields.namespace.uleb128,
    wasm.local$get, ...b,
    wasm.call, ...types.Symbol.fields.namespace.uleb128,
    wasm.call, ...eq.uleb128,
    wasm.local$get, ...a,
    wasm.call, ...types.Symbol.fields.name.uleb128,
    wasm.local$get, ...b,
    wasm.call, ...types.Symbol.fields.name.uleb128,
    wasm.call, ...eq.uleb128,
    wasm.i32$and
  ];
});

/*-------*\
|         |
| HashMap |
|         |
\*-------*/

const empty_partial_node = comp.PartialNode(empty_refs_array, 0),
// todo: start with full_node, implement node methods for nil
      empty_hash_map = comp.HashMap(empty_partial_node, 0);

const map_node_assoc = pre_new_method(6, 0, 0, 1, 0, 0, {}),
      map_node_lookup = pre_new_method(4, 0, 0, 1, 0, 0, {});

impl_free(types.PartialNode, function (free_self) {
  const node = [0];
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.PartialNode.fields.arr.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

impl_free(types.FullNode, function (free_self) {
  const node = [0];
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.FullNode.fields.arr.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

impl_free(types.HashCollisionNode, function (free_self) {
  const node = [0];
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.HashCollisionNode.fields.arr.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

impl_free(types.LeafNode, function (free_self) {
  const node = [0];
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.LeafNode.fields.key.uleb128,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...node,
    wasm.call, ...types.LeafNode.fields.val.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

impl_free(types.HashMap, function (free_self) {
  const map = [0];
  return [
    wasm.local$get, ...map,
    wasm.call, ...types.HashMap.fields.count.uleb128,
    wasm.if, wasm.void,
      wasm.local$get, ...map,
      wasm.call, ...types.HashMap.fields.root.uleb128,
      wasm.call, ...free.uleb128,
      ...free_self,
    wasm.end
  ];
});

// todo: use idx and end_idx
function map_node_for_each (node, accum, idx, end_idx, accum_idx, func) {
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.PartialNode.fields.arr.uleb128,
    wasm.local$get, ...accum,
    wasm.i32$const, 0,
    wasm.i32$const, ...sleb128i32(-1),
    wasm.local$get, ...accum_idx,
    wasm.local$get, ...func,
    wasm.call, ...refs_array_for_each.uleb128,
  ];
}

for_each.implement(types.PartialNode, map_node_for_each);
for_each.implement(types.FullNode, map_node_for_each);
for_each.implement(types.HashCollisionNode, map_node_for_each);

for_each.implement(types.LeafNode,
  function (node, accum, idx, end_idx, accum_idx, func) {
    return [
      wasm.local$get, ...node,
      wasm.local$get, ...accum,
      wasm.local$get, ...accum_idx,
      wasm.local$get, ...func,
      wasm.call, ...call_for_each.uleb128,
    ];
  }
);

for_each.implement(types.HashMap,
  function (map, accum, idx, end_idx, accum_idx, func) {
    return [
      wasm.local$get, ...map,
      wasm.call, ...types.HashMap.fields.root.uleb128,
      wasm.local$get, ...accum,
      wasm.local$get, ...idx,
      wasm.local$get, ...end_idx,
      wasm.local$get, ...accum_idx,
      wasm.local$get, ...func,
      wasm.call, ...for_each.uleb128
    ];
  }
);

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
const mask = funcs.build(
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
const bitpos = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (hash, shift) {
    return [
      wasm.i32$const, 1,
      wasm.local$get, ...hash,
      wasm.local$get, ...shift,
      wasm.call, ...mask.uleb128,
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
const bitmap_indexed_node_index = funcs.build(
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
    wasm.call, ...bitpos.uleb128,
    wasm.local$tee, ...bit,
    wasm.local$get, ...node,
    wasm.call, ...types.PartialNode.fields.bitmap.uleb128,
    wasm.local$tee, ...bitmap,
    wasm.i32$and,
    wasm.local$get, ...bitmap,
    wasm.local$get, ...bit,
    wasm.call, ...bitmap_indexed_node_index.uleb128,
    wasm.local$set, ...idx,
    wasm.local$get, ...node,
    wasm.call, ...types.PartialNode.fields.arr.uleb128,
    wasm.local$set, ...arr,
    wasm.if, wasm.i32,
      wasm.local$get, ...arr,
      wasm.local$get, ...idx,
      wasm.call, ...refs_array_get.uleb128,
      wasm.local$tee, ...child_node,
      wasm.local$get, ...child_node,
      wasm.local$get, ...shift,
      wasm.i32$const, 5,
      wasm.i32$add,
      wasm.local$get, ...hsh,
      wasm.local$get, ...key,
      wasm.local$get, ...val,
      wasm.local$get, ...added_leaf,
      wasm.call, ...map_node_assoc.uleb128,
      wasm.local$tee, ...child_node,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...node,
      wasm.else,
        wasm.local$get, ...arr,
        wasm.call, ...refs_array_clone.uleb128,
        wasm.local$get, ...idx,
        wasm.local$get, ...child_node,
        wasm.call, ...refs_array_set_no_inc.uleb128,
        wasm.local$get, ...bitmap,
        wasm.call, ...types.PartialNode.constr.uleb128,
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
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$tee, ...len,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.call, ...refs_array_by_length.uleb128,
      wasm.i32$const, 0,
      wasm.local$get, ...idx,
      wasm.call, ...refs_array_copy.uleb128,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$get, ...len,
      wasm.local$get, ...idx,
      wasm.i32$sub,
      wasm.call, ...refs_array_copy.uleb128,
      wasm.local$get, ...idx,
      wasm.local$get, ...key,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.uleb128,
      wasm.call, ...types.LeafNode.constr.uleb128,
      wasm.call, ...refs_array_set_no_inc.uleb128,
      wasm.local$set, ...arr,
      wasm.local$get, ...len,
      wasm.i32$const, ...sleb128i32(31),
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...arr,
        wasm.call, ...types.FullNode.constr.uleb128,
      wasm.else,
        wasm.local$get, ...arr,
        wasm.local$get, ...bitmap,
        wasm.local$get, ...bit,
        wasm.i32$or,
        wasm.call, ...types.PartialNode.constr.uleb128,
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
    wasm.call, ...types.FullNode.fields.arr.uleb128,
    wasm.local$tee, ...arr,
    wasm.local$get, ...hsh,
    wasm.local$get, ...shift,
    wasm.call, ...mask.uleb128,
    wasm.local$tee, ...idx,
    wasm.call, ...refs_array_get.uleb128,
    wasm.local$tee, ...child_node,
    wasm.local$get, ...child_node,
    wasm.local$get, ...shift,
    wasm.i32$const, 5,
    wasm.i32$add,
    wasm.local$get, ...hsh,
    wasm.local$get, ...key,
    wasm.local$get, ...val,
    wasm.local$get, ...added_leaf,
    wasm.call, ...map_node_assoc.uleb128,
    wasm.local$tee, ...child_node,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
    wasm.else,
      wasm.local$get, ...arr,
      wasm.call, ...refs_array_clone.uleb128,
      wasm.local$get, ...idx,
      wasm.local$get, ...child_node,
      wasm.call, ...refs_array_set_no_inc.uleb128,
      wasm.call, ...types.FullNode.constr.uleb128,
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
    wasm.call, ...types.LeafNode.fields.key.uleb128,
    wasm.local$tee, ...key2,
    wasm.local$get, ...key,
    wasm.call, ...eq.uleb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
      wasm.call, ...types.LeafNode.fields.val.uleb128,
      wasm.local$get, ...val,
      wasm.call, ...eq.uleb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...node,
      wasm.else,
        wasm.local$get, ...key,
        wasm.call, ...inc_refs.uleb128,
        wasm.local$get, ...val,
        wasm.call, ...inc_refs.uleb128,
        wasm.call, ...types.LeafNode.constr.uleb128,
      wasm.end,
    wasm.else,
      wasm.local$get, ...added_leaf,
      wasm.i32$const, 1,
      wasm.i32$store, 2, 0,
      wasm.local$get, ...key2,
      wasm.call, ...hash.uleb128,
      wasm.local$tee, ...hsh2,
      wasm.local$get, ...hsh,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.i32$const, 2,
        wasm.call, ...refs_array_by_length.uleb128,
        wasm.i32$const, 0,
        wasm.local$get, ...node,
        wasm.call, ...refs_array_set.uleb128,
        wasm.i32$const, 1,
        wasm.local$get, ...key,
        wasm.call, ...inc_refs.uleb128,
        wasm.local$get, ...val,
        wasm.call, ...inc_refs.uleb128,
        wasm.call, ...types.LeafNode.constr.uleb128,
        wasm.call, ...refs_array_set_no_inc.uleb128,
        wasm.local$get, ...hsh,
        wasm.call, ...types.HashCollisionNode.constr.uleb128,
      wasm.else,
        wasm.i32$const, ...sleb128i32(empty_partial_node),
        wasm.local$get, ...shift,
        wasm.local$get, ...hsh2,
        wasm.local$get, ...key2,
        wasm.local$get, ...node,
        wasm.call, ...types.LeafNode.fields.val.uleb128,
        wasm.local$get, ...added_leaf,
        wasm.call, ...map_node_assoc.uleb128,
        wasm.local$tee, ...node,
        wasm.local$get, ...shift,
        wasm.local$get, ...hsh,
        wasm.local$get, ...key,
        wasm.local$get, ...val,
        wasm.local$get, ...added_leaf,
        wasm.call, ...map_node_assoc.uleb128,
        wasm.local$get, ...node,
        wasm.call, ...free.uleb128,
      wasm.end,
    wasm.end
  ];
});

const hash_collision_node_find_entry = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32, wasm.i32], {},
  function (node, key) {
    const idx = this.local(wasm.i32),
          arr = this.local(wasm.i32),
          len = this.local(wasm.i32),
          leaf = this.local(wasm.i32);
    return [
      wasm.local$get, ...node,
      wasm.call, ...types.HashCollisionNode.fields.arr.uleb128,
      wasm.local$tee, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$set, ...len,
      wasm.loop, wasm.i32,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx,
        wasm.call, ...refs_array_get.uleb128,
        wasm.local$tee, ...leaf,
        wasm.call, ...types.LeafNode.fields.key.uleb128,
        wasm.local$get, ...key,
        wasm.call, ...eq.uleb128,
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
    wasm.call, ...types.HashCollisionNode.fields.collision_hash.uleb128,
    wasm.local$tee, ...hsh2,
    wasm.local$get, ...hsh,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
      wasm.call, ...types.HashCollisionNode.fields.arr.uleb128,
      wasm.local$tee, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$set, ...len,
      wasm.local$get, ...node,
      wasm.local$get, ...key,
      wasm.call, ...hash_collision_node_find_entry.uleb128,
      wasm.local$set, ...idx,
      wasm.local$tee, ...leaf,
      wasm.if, wasm.i32,
        wasm.local$get, ...leaf,
        wasm.call, ...types.LeafNode.fields.val.uleb128,
        wasm.local$get, ...val,
        wasm.call, ...eq.uleb128,
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
          wasm.call, ...refs_array_clone.uleb128,
        wasm.else,
          wasm.local$get, ...arr,
          wasm.local$get, ...len,
          wasm.call, ...refs_array_fit_and_copy.uleb128,
        wasm.end,
        wasm.local$get, ...leaf,
        wasm.if, wasm.i32,
          wasm.local$get, ...idx,
        wasm.else,
          wasm.local$get, ...len,
        wasm.end,
        wasm.local$get, ...key,
        wasm.call, ...inc_refs.uleb128,
        wasm.local$get, ...val,
        wasm.call, ...inc_refs.uleb128,
        wasm.call, ...types.LeafNode.constr.uleb128,
        wasm.call, ...refs_array_set_no_inc.uleb128,
        wasm.local$get, ...hsh,
        wasm.call, ...types.HashCollisionNode.constr.uleb128,
      wasm.end,
    wasm.else,
      wasm.i32$const, 1,
      wasm.call, ...refs_array_by_length.uleb128,
      wasm.i32$const, 0,
      wasm.local$get, ...node,
      wasm.call, ...refs_array_set.uleb128,
      wasm.local$get, ...hsh2,
      wasm.local$get, ...shift,
      wasm.call, ...bitpos.uleb128,
      wasm.call, ...types.PartialNode.constr.uleb128,
      wasm.local$tee, ...node,
      wasm.local$get, ...shift,
      wasm.local$get, ...hsh,
      wasm.local$get, ...key,
      wasm.local$get, ...val,
      wasm.local$get, ...added_leaf,
      wasm.call, ...map_node_assoc.uleb128,
      wasm.local$get, ...node,
      wasm.call, ...free.uleb128,
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
    wasm.call, ...types.PartialNode.fields.bitmap.uleb128,
    wasm.local$tee, ...bitmap,
    wasm.local$get, ...hsh,
    wasm.local$get, ...shift,
    wasm.call, ...bitpos.uleb128,
    wasm.local$tee, ...bit,
    wasm.i32$and,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
      wasm.call, ...types.PartialNode.fields.arr.uleb128,
      wasm.local$get, ...bitmap,
      wasm.local$get, ...bit,
      wasm.call, ...bitmap_indexed_node_index.uleb128,
      wasm.call, ...refs_array_get.uleb128,
      wasm.local$get, ...shift,
      wasm.i32$const, 5,
      wasm.i32$add,
      wasm.local$get, ...hsh,
      wasm.local$get, ...key,
      wasm.call, ...map_node_lookup.uleb128,
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
    wasm.call, ...types.FullNode.fields.arr.uleb128,
    wasm.local$get, ...hsh,
    wasm.local$get, ...shift,
    wasm.call, ...mask.uleb128,
    wasm.call, ...refs_array_get.uleb128,
    wasm.local$get, ...shift,
    wasm.i32$const, 5,
    wasm.i32$add,
    wasm.local$get, ...hsh,
    wasm.local$get, ...key,
    wasm.call, ...map_node_lookup.uleb128
  ];
});

map_node_lookup.implement(types.LeafNode, function (
  node, shift, hsh, key
) {
  return [
    wasm.local$get, ...node,
    wasm.call, ...types.LeafNode.fields.key.uleb128,
    wasm.local$get, ...key,
    wasm.call, ...eq.uleb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
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
    wasm.call, ...types.HashCollisionNode.fields.collision_hash.uleb128,
    wasm.local$get, ...hsh,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...node,
      wasm.local$get, ...key,
      wasm.call, ...hash_collision_node_find_entry.uleb128,
      wasm.drop,
      wasm.local$tee, ...leaf,
      wasm.if, wasm.i32,
        wasm.local$get, ...leaf,
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
    wasm.call, ...types.HashMap.fields.root.uleb128,
    wasm.local$tee, ...root,
    wasm.i32$const, 0,
    wasm.local$get, ...key,
    wasm.call, ...hash.uleb128,
    wasm.local$get, ...key,
    wasm.local$get, ...val,
    wasm.i32$const, 4,
    wasm.call, ...alloc.uleb128,
    wasm.local$tee, ...added_leaf,
    wasm.call, ...map_node_assoc.uleb128,
    wasm.local$tee, ...new_root,
    wasm.local$get, ...root,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...map,
    wasm.else,
      wasm.local$get, ...new_root,
      wasm.local$get, ...map,
      wasm.call, ...types.HashMap.fields.count.uleb128,
      wasm.local$get, ...added_leaf,
      wasm.i32$load, 2, 0,
      wasm.i32$add,
      wasm.call, ...types.HashMap.constr.uleb128,
    wasm.end,
    wasm.local$get, ...added_leaf,
    wasm.i32$const, 4,
    wasm.call, ...free_mem.uleb128,
  ];
});

// todo: get rid of not_found, handle in comp
get.implement(types.HashMap, function (map, key, not_found) {
  const result = this.local(wasm.i32);
  return [
    wasm.local$get, ...map,
    wasm.call, ...types.HashMap.fields.root.uleb128,
    wasm.i32$const, 0,
    wasm.local$get, ...key,
    wasm.call, ...hash.uleb128,
    wasm.local$get, ...key,
    wasm.call, ...map_node_lookup.uleb128,
    wasm.local$tee, ...result,
    wasm.i32$const, ...sleb128i32(no_entry),
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...not_found,
    wasm.else,
      wasm.local$get, ...result,
      wasm.call, ...types.LeafNode.fields.val.uleb128,
    wasm.end
  ];
});

const get_map_entry = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (map, key) {
    return [
      wasm.local$get, ...map,
      wasm.call, ...types.HashMap.fields.root.uleb128,
      wasm.i32$const, 0,
      wasm.local$get, ...key,
      wasm.call, ...hash.uleb128,
      wasm.local$get, ...key,
      wasm.call, ...map_node_lookup.uleb128
    ];
  }
);

count.implement(types.HashMap, function (map) {
  return [
    wasm.local$get, ...map,
    wasm.call, ...types.HashMap.fields.count.uleb128
  ];
});

to_vec.implement(types.HashMap, function (map) {
  return [
    wasm.local$get, ...map,
    wasm.call, ...to_seq.uleb128,
    wasm.call, ...to_vec.uleb128
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

nth.implement(types.Nil, function (seq, n, not_found) {
  return [wasm.local$get, ...not_found];
});

first.implement(types.Nil, function () {
  return [wasm.i32$const, nil];
});

rest.implement(types.Nil, function () {
  return [wasm.i32$const, ...sleb128i32(empty_seq)];
});

for_each.implement(types.Nil, function () {
  return [wasm.i32$const, nil];
});

to_seq.implement(types.Nil, function () {
  return [wasm.i32$const, ...sleb128i32(empty_seq)];
});

to_vec.implement(types.Nil, function () {
  return [
    wasm.i32$const, ...sleb128i32(empty_vector)
  ];
});

// todo: will this work for user-defined seqs?
impl_free(types.Seq, function (free_self) {
  const seq = [0];
  return [
    wasm.local$get, ...seq,
    wasm.call, ...count.uleb128,
    wasm.if, wasm.void,
      wasm.local$get, ...seq,
      wasm.call, ...types.Seq.fields.root.uleb128,
      wasm.call, ...free.uleb128,
      ...free_self,
    wasm.end
  ];
});

function impl_seq_pass_through (typ, mtd) {
  mtd.implement(typ, function () {
    const args = [];
    for (let i = 0; i < mtd.num_args; i++) {
      if (i) args.push(wasm.local$get, ...sleb128i32(i));
    }
    const out = this.local(wasm.i32);
    return [
      wasm.local$get, 0,
      wasm.call, ...typ.fields.root.uleb128,
      ...args,
      wasm.call, ...mtd.uleb128,
    ];
  });
}

impl_seq_pass_through(types.Seq, count);
impl_seq_pass_through(types.Seq, first);
impl_seq_pass_through(types.Seq, nth);
impl_seq_pass_through(types.Seq, rest);

to_seq.implement(types.Seq, function (seq) {
  return [wasm.local$get, ...seq];
});

to_vec.implement(types.Seq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.Seq.fields.root.uleb128,
    wasm.call, ...to_vec.uleb128
  ];
});

for_each.implement(types.Seq,
  function (seq, accum, idx, end_idx, accum_idx, func) {
    return [
      wasm.local$get, ...seq,
      wasm.call, ...types.Seq.fields.root.uleb128,
      wasm.local$get, ...accum,
      wasm.local$get, ...idx,
      wasm.local$get, ...end_idx,
      wasm.local$get, ...accum_idx,
      wasm.local$get, ...func,
      wasm.call, ...for_each.uleb128
    ];
  }
);

function seq_to_vec (seq) {
  const arr = this.local(wasm.i32),
        cnt = this.local(wasm.i32),
        idx = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...count.uleb128,
    wasm.local$tee, ...cnt,
    wasm.call, ...refs_array_by_length.uleb128,
    wasm.local$set, ...arr,
    wasm.loop, wasm.i32,
      wasm.local$get, ...idx,
      wasm.local$get, ...cnt,
      wasm.i32$lt_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx,
        wasm.local$get, ...seq,
        wasm.local$get, ...idx,
        wasm.i32$const, nil,
        wasm.call, ...nth.uleb128,
        wasm.call, ...refs_array_set.uleb128,
        wasm.local$get, ...idx,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.local$set, ...idx,
        wasm.br, 1,
      wasm.else,
        wasm.local$get, ...arr,
      wasm.end,
    wasm.end,
// todo: array is inc_ref'd, need to free?
    wasm.call, ...vector_from_array.uleb128
  ];
}

/*-------*\
|         |
| ConsSeq |
|         |
\*-------*/

impl_free(types.ConsSeq, function (free_self) {
  const seq = [0];
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConsSeq.fields.first.uleb128,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.ConsSeq.fields.rest.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

count.implement(types.ConsSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConsSeq.fields.rest.uleb128,
    wasm.call, ...count.uleb128,
    wasm.i32$const, 1,
    wasm.i32$add
  ];
});

first.implement(types.ConsSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConsSeq.fields.first.uleb128
  ];
});

rest.implement(types.ConsSeq, function (seq) {
  const out = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConsSeq.fields.rest.uleb128,
    wasm.call, ...types.Seq.fields.root.uleb128,
    wasm.call, ...inc_refs.uleb128,
    wasm.call, ...types.Seq.constr.uleb128
  ];
});

nth.implement(types.ConsSeq, function (seq, n, not_found) {
  return [
    wasm.local$get, ...n,
    wasm.if, wasm.i32,
      wasm.local$get, ...seq,
      wasm.call, ...types.ConsSeq.fields.rest.uleb128,
      wasm.local$get, ...n,
      wasm.i32$const, 1,
      wasm.i32$sub,
      wasm.local$get, ...not_found,
      wasm.call, ...nth.uleb128,
    wasm.else,
      wasm.local$get, ...seq,
      wasm.call, ...types.ConsSeq.fields.first.uleb128,
    wasm.end
  ];
});

// todo: skip first if idx > 0
for_each.implement(types.ConsSeq,
  function (seq, accum, idx, end_idx, accum_idx, func) {
    const rest = this.local(wasm.i32),
          cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...seq,
      wasm.call, ...types.ConsSeq.fields.first.uleb128,
      wasm.local$get, ...accum,
      wasm.local$get, ...accum_idx,
      wasm.local$get, ...func,
      wasm.call, ...call_for_each.uleb128,
      wasm.local$set, ...accum,
      wasm.local$get, ...seq,
      wasm.call, ...types.ConsSeq.fields.rest.uleb128,
      wasm.local$tee, ...rest,
      wasm.call, ...count.uleb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...rest,
        wasm.local$get, ...accum,
// todo: adjust for idx > 1
        wasm.i32$const, 0,
        wasm.local$get, ...end_idx,
        wasm.local$get, ...accum_idx,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.local$get, ...func,
        wasm.call, ...for_each.uleb128,
        //wasm.local$tee, ...accum,
        //wasm.local$get, ...accum,
        //wasm.local$get, ...old_accum,
        //wasm.i32$ne,
        //wasm.if, wasm.void,
        //  wasm.local$get, ...old_accum,
        //  wasm.call, ...free.uleb128,
        //wasm.end,
      wasm.else,
        wasm.local$get, ...accum,
      wasm.end
    ];
  }
);

to_vec.implement(types.ConsSeq, seq_to_vec);

const cons = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { comp: "cons" },
  function (val, coll) {
    const rest = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$get, ...coll,
      wasm.call, ...to_seq.uleb128,
      wasm.local$tee, ...rest,
      wasm.local$get, ...coll,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...rest,
        wasm.call, ...inc_refs.uleb128,
      wasm.else,
        wasm.local$get, ...rest,
      wasm.end,
      wasm.call, ...types.ConsSeq.constr.uleb128,
      wasm.call, ...types.Seq.constr.uleb128,
    ];
  }
);

/*-------*\
|         |
| LazySeq |
|         |
\*-------*/

const gen_seq = funcs.build(
  [wasm.i32], [], {},
  function (seq) {
    const gen = this.local(wasm.i32);
    return [
      wasm.local$get, ...seq,
      wasm.call, ...types.LazySeq.fields.seq_set.uleb128,
      wasm.i32$eqz,
      wasm.if, wasm.void,
        wasm.local$get, ...seq,
        wasm.i32$const, ...sleb128i32(types.LazySeq.fields.seq.offset),
        wasm.i32$add,
        wasm.local$get, ...seq,
        wasm.call, ...types.LazySeq.fields.generator.uleb128,
        wasm.local$tee, ...gen,
        //wasm.call, ...types.VariadicFunction.fields.args.uleb128,
        wasm.local$get, ...gen,
        wasm.call, ...func_tbl_idx.uleb128,
        //wasm.call, ...types.VariadicFunction.fields.func.uleb128,
        //wasm.call, ...types.Function.fields.tbl_idx.uleb128,
        wasm.call_indirect,
        ...sleb128i32(get_type_idx(1, 0, 0, 1, 0, 0)), 0,
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

impl_free(types.LazySeq, function (free_self) {
  const seq = [0];
  return [
// todo: needed?
    //wasm.local$get, ...seq,
    //wasm.call, ...gen_seq.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.LazySeq.fields.generator.uleb128,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.LazySeq.fields.seq.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

first.implement(types.LazySeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...gen_seq.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.LazySeq.fields.seq.uleb128,
    wasm.call, ...first.uleb128,
  ];
});

rest.implement(types.LazySeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...gen_seq.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.LazySeq.fields.seq.uleb128,
    wasm.call, ...rest.uleb128,
  ];
});

// todo: implement for_each
// todo: implement nth

count.implement(types.LazySeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...gen_seq.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.LazySeq.fields.seq.uleb128,
    wasm.call, ...count.uleb128
  ];
});

to_vec.implement(types.LazySeq, seq_to_vec);

const lazy_seq = funcs.build(
  [wasm.i32], [wasm.i32], { comp: "lazy-seq" },
  function (gen) {
    return [
      wasm.local$get, ...gen,
      wasm.call, ...inc_refs.uleb128,
      wasm.i32$const, nil,
      wasm.i32$const, 0,
      wasm.call, ...types.LazySeq.constr.uleb128,
      wasm.call, ...types.Seq.constr.uleb128
    ];
  }
);

/*---------*\
|           |
| ConcatSeq |
|           |
\*---------*/

impl_free(types.ConcatSeq, function (free_self) {
  const seq = [0];
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.left.uleb128,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.right.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

count.implement(types.ConcatSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.left.uleb128,
    wasm.call, ...count.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.right.uleb128,
    wasm.call, ...count.uleb128,
    wasm.i32$add
  ];
});

first.implement(types.ConcatSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.left.uleb128,
    wasm.call, ...first.uleb128
  ];
});

rest.implement(types.ConcatSeq, function (seq) {
  const left = this.local(wasm.i32),
        right = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.right.uleb128,
    wasm.local$set, ...right,
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.left.uleb128,
    wasm.call, ...rest.uleb128,
    wasm.local$tee, ...left,
    wasm.call, ...count.uleb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...left,
      wasm.local$get, ...right,
      wasm.call, ...inc_refs.uleb128,
      wasm.call, ...types.ConcatSeq.constr.uleb128,
      wasm.call, ...types.Seq.constr.uleb128,
    wasm.else,
      wasm.local$get, ...right,
      wasm.call, ...types.Seq.fields.root.uleb128,
      wasm.call, ...inc_refs.uleb128,
      wasm.call, ...types.Seq.constr.uleb128,
    wasm.end
  ];
});

nth.implement(types.ConcatSeq, function (seq, n, not_found) {
  const left = this.local(wasm.i32),
        lcnt = this.local(wasm.i32);
  return [
    wasm.local$get, ...n,
    wasm.local$get, ...seq,
    wasm.call, ...types.ConcatSeq.fields.left.uleb128,
    wasm.local$tee, ...left,
    wasm.call, ...count.uleb128,
    wasm.local$tee, ...lcnt,
    wasm.i32$lt_u,
    wasm.if, wasm.i32,
      wasm.local$get, ...left,
      wasm.local$get, ...n,
      wasm.local$get, ...not_found,
      wasm.call, ...nth.uleb128,
    wasm.else,
      wasm.local$get, ...seq,
      wasm.call, ...types.ConcatSeq.fields.right.uleb128,
      wasm.local$get, ...n,
      wasm.local$get, ...lcnt,
      wasm.i32$sub,
      wasm.local$get, ...not_found,
      wasm.call, ...nth.uleb128,
    wasm.end
  ];
});

// todo: skip left if idx > count
// adjust end_idx for right
for_each.implement(types.ConcatSeq,
  function (seq, accum, idx, end_idx, accum_idx, func) {
    const old_accum = this.local(wasm.i32),
          lft = this.local(wasm.i32),
          cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...seq,
      wasm.call, ...types.ConcatSeq.fields.left.uleb128,
      wasm.local$tee, ...lft,
      wasm.local$get, ...accum,
      wasm.local$get, ...idx,
      wasm.local$get, ...end_idx,
      wasm.local$get, ...accum_idx,
      wasm.local$get, ...func,
      wasm.call, ...for_each.uleb128,
      wasm.local$set, ...old_accum,
      wasm.local$get, ...seq,
      wasm.call, ...types.ConcatSeq.fields.right.uleb128,
      wasm.local$get, ...old_accum,
      wasm.i32$const, 0,
      wasm.local$get, ...end_idx,
      wasm.local$get, ...accum_idx,
      wasm.local$get, ...lft,
      wasm.call, ...count.uleb128,
      wasm.i32$add,
      wasm.local$get, ...func,
      wasm.call, ...for_each.uleb128,
      wasm.local$tee, ...accum,
      wasm.local$get, ...accum,
      wasm.local$get, ...old_accum,
      wasm.i32$ne,
      wasm.if, wasm.void,
        wasm.local$get, ...old_accum,
        wasm.call, ...free.uleb128,
      wasm.end
    ];
  }
);

to_vec.implement(types.ConcatSeq, seq_to_vec);

const concat = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { comp: "concat" },
  function (left, right) {
    return [
      wasm.local$get, ...left,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$get, ...right,
      wasm.call, ...inc_refs.uleb128,
      wasm.call, ...types.ConcatSeq.constr.uleb128,
      wasm.call, ...types.Seq.constr.uleb128
    ];
  }
);

/*---------*\
|           |
| VectorSeq |
|           |
\*---------*/

impl_free(types.VectorSeq, function (free_self) {
  const seq = [0];
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.vec.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

count.implement(types.VectorSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.vec.uleb128,
    wasm.call, ...count.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.node_off.uleb128,
    wasm.i32$sub,
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.arr_off.uleb128,
    wasm.i32$sub
  ];
});

first.implement(types.VectorSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.arr.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.arr_off.uleb128,
    wasm.call, ...refs_array_get.uleb128
  ];
});

rest.implement(types.VectorSeq, function (seq) {
  const len = this.local(wasm.i32),
        arr = this.local(wasm.i32),
        arr_off = this.local(wasm.i32),
        vec = this.local(wasm.i32),
        node_off = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...count.uleb128,
    wasm.i32$const, 1,
    wasm.i32$gt_u,
    wasm.if, wasm.i32,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.vec.uleb128,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$set, ...vec,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.node_off.uleb128,
      wasm.local$set, ...node_off,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.arr_off.uleb128,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$tee, ...arr_off,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.arr.uleb128,
      wasm.local$tee, ...arr,
      wasm.call, ...types.RefsArray.fields.arr.uleb128,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$tee, ...len,
      wasm.i32$lt_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...arr,
        wasm.local$get, ...arr_off,
        wasm.local$get, ...vec,
        wasm.local$get, ...node_off,
        wasm.call, ...types.VectorSeq.constr.uleb128,
      wasm.else,
        wasm.local$get, ...vec,
        wasm.local$get, ...node_off,
        wasm.local$get, ...len,
        wasm.i32$add,
        wasm.local$tee, ...node_off,
        wasm.call, ...unchecked_array_for.uleb128,
        wasm.i32$const, 0,
        wasm.local$get, ...vec,
        wasm.local$get, ...node_off,
        wasm.call, ...types.VectorSeq.constr.uleb128,
      wasm.end,
      wasm.call, ...types.Seq.constr.uleb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

nth.implement(types.VectorSeq, function (seq, n, not_found) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.vec.uleb128,
    wasm.local$get, ...n,
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.node_off.uleb128,
    wasm.i32$add,
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.arr_off.uleb128,
    wasm.i32$add,
    wasm.local$get, ...not_found,
    wasm.call, ...nth.uleb128
  ];
});

for_each.implement(types.VectorSeq,
  function (seq, accum, idx, end_idx, accum_idx, func) {
    const vec = this.local(wasm.i32);
    return [
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.vec.uleb128,
      wasm.local$tee, ...vec,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.root.uleb128,
      wasm.local$get, ...accum,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.node_off.uleb128,
      wasm.local$get, ...seq,
      wasm.call, ...types.VectorSeq.fields.arr_off.uleb128,
      wasm.i32$add,
      wasm.local$get, ...idx,
      wasm.i32$add,
      wasm.local$get, ...end_idx,
      wasm.local$get, ...accum_idx,
      wasm.local$get, ...vec,
      wasm.call, ...types.Vector.fields.shift.uleb128,
      wasm.local$get, ...func,
      wasm.call, ...vec_node_for_each.uleb128
    ];
  }
);

// todo: need to account for node_off
to_vec.implement(types.VectorSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.VectorSeq.fields.vec.uleb128
  ];
});

to_seq.implement(types.Vector, function (vec) {
  const cnt = this.local(wasm.i32),
        shift = this.local(wasm.i32),
        arr = this.local(wasm.i32);
  return [
    wasm.local$get, ...vec,
    wasm.call, ...count.uleb128,
    wasm.local$tee, ...cnt,
    wasm.if, wasm.i32,
      wasm.local$get, ...vec,
      wasm.call, ...inc_refs.uleb128,
      wasm.drop,
      wasm.local$get, ...cnt,
      wasm.i32$const, 32,
      wasm.i32$le_u,
      wasm.if, wasm.i32,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.tail.uleb128,
      wasm.else,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.shift.uleb128,
        wasm.local$set, ...shift,
        wasm.local$get, ...vec,
        wasm.call, ...types.Vector.fields.root.uleb128,
        wasm.local$set, ...arr,
        wasm.loop, wasm.i32,
          wasm.local$get, ...shift,
          wasm.if, wasm.i32,
            wasm.local$get, ...arr,
            wasm.i32$const, 0,
            wasm.call, ...refs_array_get.uleb128,
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
      wasm.call, ...types.VectorSeq.constr.uleb128,
      wasm.call, ...types.Seq.constr.uleb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

const vector_seq_from_array = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (arr) {
    return [
      wasm.local$get, ...arr,
      wasm.call, ...vector_from_array.uleb128,
      wasm.call, ...to_seq.uleb128
    ];
  }
);

/*------------*\
|              |
| RefsArraySeq |
|              |
\*------------*/

impl_free(types.RefsArraySeq, function (free_self) {
  const seq = [0];
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

count.implement(types.RefsArraySeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
    wasm.call, ...types.RefsArray.fields.arr.uleb128,
    wasm.call, ...types.Array.fields.length.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.RefsArraySeq.fields.offset.uleb128,
    wasm.i32$sub
  ];
});

first.implement(types.RefsArraySeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.RefsArraySeq.fields.offset.uleb128,
    wasm.call, ...refs_array_get.uleb128,
  ];
});

rest.implement(types.RefsArraySeq, function (seq) {
  const off = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.RefsArraySeq.fields.offset.uleb128,
    wasm.i32$const, 1,
    wasm.i32$add,
    wasm.local$tee, ...off,
    wasm.local$get, ...seq,
// todo: implement count for RefsArray so we don't
// have to do this all the time
    wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
    wasm.call, ...types.RefsArray.fields.arr.uleb128,
    wasm.call, ...types.Array.fields.length.uleb128,
    wasm.i32$lt_u,
    wasm.if, wasm.i32,
      wasm.local$get, ...seq,
      wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$get, ...off,
      wasm.call, ...types.RefsArraySeq.constr.uleb128,
      wasm.call, ...types.Seq.constr.uleb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

// todo: implement for refs_array directly
nth.implement(types.RefsArraySeq, function (seq, n, not_found) {
  return [
    wasm.local$get, ...n,
    wasm.local$get, ...seq,
    wasm.call, ...types.RefsArraySeq.fields.offset.uleb128,
    wasm.i32$add,
    wasm.local$tee, ...n,
    wasm.local$get, ...seq,
    wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
    wasm.call, ...types.RefsArray.fields.arr.uleb128,
    wasm.call, ...types.Array.fields.length.uleb128,
    wasm.i32$lt_u,
    wasm.if, wasm.i32,
      wasm.local$get, ...seq,
      wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
      wasm.local$get, ...n,
      wasm.call, ...refs_array_get.uleb128,
    wasm.else,
      wasm.local$get, ...not_found,
    wasm.end
  ];
});

for_each.implement(types.RefsArraySeq,
  function (seq, accum, idx, end_idx, accum_idx, func) {
    return [
      wasm.local$get, ...seq,
      wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
      wasm.local$get, ...accum,
      wasm.local$get, ...seq,
      wasm.call, ...types.RefsArraySeq.fields.offset.uleb128,
      wasm.local$get, ...idx,
      wasm.i32$add,
      wasm.local$tee, ...idx,
      wasm.local$get, ...end_idx,
      wasm.local$get, ...accum_idx,
      wasm.local$get, ...func,
      wasm.call, ...refs_array_for_each.uleb128
    ];
  }
);

// todo: replace with real implementation
to_vec.implement(types.RefsArraySeq, seq_to_vec);

to_seq.implement(types.RefsArray, function (arr) {
  return [
    wasm.local$get, ...arr,
    wasm.call, ...types.RefsArray.fields.arr.uleb128,
    wasm.call, ...types.Array.fields.length.uleb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...arr,
      wasm.call, ...inc_refs.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...types.RefsArraySeq.constr.uleb128,
      wasm.call, ...types.Seq.constr.uleb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

/*----------*\
|            |
| HashMapSeq |
|            |
\*----------*/

// todo: make sure it's putting key, val in vector

impl_free(types.HashMapSeq, function (free_self) {
  const seq = [0];
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapSeq.fields.map.uleb128,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapSeq.fields.root.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

impl_free(types.HashMapNodeSeq, function (free_self) {
  const seq = [0];
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapNodeSeq.fields.curr_seq.uleb128,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapNodeSeq.fields.nodes.uleb128,
    wasm.call, ...free.uleb128,
    ...free_self
  ];
});

count.implement(types.HashMapSeq, function (seq) {
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapSeq.fields.map.uleb128,
    wasm.call, ...count.uleb128
  ];
});

impl_seq_pass_through(types.HashMapSeq, first);
impl_seq_pass_through(types.HashMapSeq, nth);

rest.implement(types.HashMapSeq, function (seq) {
  const out = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapSeq.fields.root.uleb128,
    wasm.call, ...rest.uleb128,
    wasm.local$tee, ...out,
    wasm.if, wasm.i32,
      wasm.local$get, ...seq,
      wasm.call, ...types.HashMapSeq.fields.map.uleb128,
      wasm.local$get, ...out,
      wasm.call, ...types.HashMapSeq.constr.uleb128,
      wasm.call, ...types.Seq.constr.uleb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

const hash_map_node_seq = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (arr, off) {
    const node = this.local(wasm.i32);
    return [
      wasm.local$get, ...arr,
      wasm.local$get, ...off,
      wasm.call, ...refs_array_get.uleb128,
      wasm.local$tee, ...node,
      wasm.i32$load, 2, 0,
      wasm.i32$const, ...sleb128i32(types.LeafNode.type_num),
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.i32$const, nil,
      wasm.else,
        wasm.local$get, ...node,
        wasm.i32$const, 0,
        wasm.call, ...this.uleb128,
      wasm.end,
      wasm.local$get, ...arr,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$get, ...off,
      wasm.call, ...types.HashMapNodeSeq.constr.uleb128
    ];
  }
);

first.implement(types.HashMapNodeSeq, function (seq) {
  const curr_seq = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapNodeSeq.fields.curr_seq.uleb128,
    wasm.local$tee, ...curr_seq,
    wasm.if, wasm.i32,
      wasm.local$get, ...curr_seq,
      wasm.call, ...first.uleb128,
    wasm.else,
      wasm.local$get, ...seq,
      wasm.call, ...types.HashMapNodeSeq.fields.nodes.uleb128,
      wasm.local$get, ...seq,
      wasm.call, ...types.HashMapNodeSeq.fields.offset.uleb128,
      wasm.call, ...refs_array_get.uleb128,
    wasm.end
  ];
});

rest.implement(types.HashMapNodeSeq, function (seq) {
  const off = this.local(wasm.i32),
        nodes = this.local(wasm.i32);
  return [
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapNodeSeq.fields.nodes.uleb128,
    wasm.local$tee, ...nodes,
    wasm.call, ...types.RefsArray.fields.arr.uleb128,
    wasm.call, ...types.Array.fields.length.uleb128,
    wasm.local$get, ...seq,
    wasm.call, ...types.HashMapNodeSeq.fields.offset.uleb128,
    wasm.i32$const, 1,
    wasm.i32$add,
    wasm.local$tee, ...off,
    wasm.i32$gt_u,
    wasm.if, wasm.i32,
      wasm.local$get, ...nodes,
      wasm.local$get, ...off,
      wasm.call, ...hash_map_node_seq.uleb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

// todo: implement for_each

to_seq.implement(types.HashMap, function (map) {
  const root = this.local(wasm.i32);
  return [
    wasm.local$get, ...map,
    wasm.call, ...types.HashMap.fields.count.uleb128,
    wasm.if, wasm.i32,
      wasm.local$get, ...map,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$get, ...map,
      wasm.call, ...types.HashMap.fields.root.uleb128,
      wasm.call, ...types.PartialNode.fields.arr.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...hash_map_node_seq.uleb128,
      wasm.call, ...types.HashMapSeq.constr.uleb128,
      wasm.call, ...types.Seq.constr.uleb128,
    wasm.else,
      wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.end
  ];
});

to_vec.implement(types.HashMapSeq, seq_to_vec);

/*-------*\
|         |
| keyword |
|         |
\*-------*/

const keyword_store = new_atom(empty_hash_map),
      keywords = {};

// todo: comp function should automatically pass 1 for do_free
const keyword = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32],
  { export: "keyword", comp: "keyword" },
  function (namespace, name, do_free) {
    const kws = this.local(wasm.i32),
          with_ns = this.local(wasm.i32),
          out = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(keyword_store),
      wasm.call, ...atom_swap_lock.uleb128,
      wasm.local$tee, ...kws,
      wasm.local$get, ...namespace,
      // wasm.i32$const, ...sleb128i32(no_entry),
      wasm.call, ...get_map_entry.uleb128,
      wasm.local$tee, ...with_ns,
      wasm.i32$const, ...sleb128i32(no_entry),
      wasm.i32$ne,
      wasm.if, wasm.i32,
        wasm.local$get, ...do_free,
        wasm.if, wasm.void,
          wasm.local$get, ...namespace,
          wasm.call, ...free.uleb128,
        wasm.end,
        wasm.local$get, ...with_ns,
        wasm.call, ...types.LeafNode.fields.key.uleb128,
        wasm.local$set, ...namespace,
        wasm.local$get, ...with_ns,
        wasm.call, ...types.LeafNode.fields.val.uleb128,
        wasm.local$tee, ...with_ns,
        wasm.local$get, ...name,
        wasm.i32$const, 0,
        wasm.call, ...get.uleb128,
        wasm.local$tee, ...out,
      wasm.else,
        wasm.i32$const, ...sleb128i32(empty_hash_map),
        wasm.local$set, ...with_ns,
        wasm.i32$const, 0,
      wasm.end,
      wasm.if, wasm.void,
        wasm.local$get, ...do_free,
        wasm.if, wasm.void,
          wasm.local$get, ...name,
          wasm.call, ...free.uleb128,
        wasm.end,
        wasm.i32$const, ...sleb128i32(keyword_store),
        wasm.call, ...atom_swap_unlock.uleb128,
        wasm.drop,
      wasm.else,
        wasm.local$get, ...namespace,
        wasm.if, wasm.i32,
          wasm.local$get, ...namespace,
          wasm.call, ...force_to_string.uleb128,
        wasm.else,
          wasm.local$get, ...namespace,
        wasm.end,
        wasm.call, ...inc_refs.uleb128,
        wasm.local$get, ...name,
        wasm.call, ...force_to_string.uleb128,
        wasm.call, ...inc_refs.uleb128,
        wasm.call, ...types.Keyword.constr.uleb128,
        wasm.local$set, ...out,
        wasm.i32$const, ...sleb128i32(keyword_store),
        wasm.local$get, ...kws,
        wasm.local$get, ...namespace,
        wasm.local$get, ...with_ns,
        wasm.local$get, ...name,
        wasm.local$get, ...out,
        wasm.call, ...assoc.uleb128,
        wasm.call, ...assoc.uleb128,
        wasm.call, ...atom_swap_set.uleb128,
        wasm.drop,
        wasm.local$get, ...with_ns,
        wasm.call, ...free.uleb128,
        wasm.local$get, ...kws,
        wasm.call, ...free.uleb128,
      wasm.end,
      wasm.local$get, ...out,
    ];
  }
);

const sym_to_kw = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (sym) {
    const ns = this.local(wasm.i32);
    return [
      wasm.local$get, ...sym,
      wasm.call, ...types.Symbol.fields.namespace.uleb128,
      wasm.local$get, ...sym,
      wasm.call, ...types.Symbol.fields.name.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...keyword.uleb128,
    ];
  }
);

function make_keyword (ns, nm) {
  if (typeof nm === "string") {
    ns = cached_string(ns);
    nm = cached_string(nm);
  } else {
    nm = cached_string(ns);
    ns = 0;
  }
  return comp.keyword(ns, nm, 0);
}

/*------*\
|        |
| symbol |
|        |
\*------*/

const symbol = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { comp: "symbol" },
  function (ns, nm) {
    return [
      wasm.local$get, ...ns,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$get, ...nm,
      wasm.call, ...inc_refs.uleb128,
      wasm.call, ...types.Symbol.constr.uleb128
    ];
  }
);

function make_symbol (ns, nm) {
  if (typeof nm === "string") {
    nm = cached_string(nm);
    if (typeof ns === "string") {
      ns = cached_string(ns);
    } else {
      ns = 0;
    }
  } else {
    nm = cached_string(ns);
    ns = 0;
  }
  return comp.Symbol(comp.inc_refs(ns), comp.inc_refs(nm));
}

compile();

/*----*\
|      |
| size |
|      |
\*----*/

// todo: need?

//const size = pre_new_method(1, 0, 0, wasm.i32, { export: "size" });
//
//size.implement(types.Nil, () => [wasm.i32$const, 4]);
//
//size.implement(types.Array, function (arr) {
//  return [
//    wasm.i32$const, ...sleb128i32(types.Array.size),
//    wasm.local$get, ...arr,
//    wasm.call, ...types.Array.fields.length.uleb128,
//    wasm.i32$add,
//    wasm.local$get, ...arr,
//    wasm.call, ...types.Array.fields.original.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add
//  ];
//});
//
//size.implement(types.String, function (str) {
//  return [
//    wasm.i32$const, ...sleb128i32(types.String.size),
//    wasm.local$get, ...str,
//    wasm.call, ...types.String.fields.arr.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add
//  ];
//});
//
//size.implement(types.Symbol, function (sym) {
//  return [
//    wasm.i32$const, ...sleb128i32(types.Symbol.size),
//    wasm.local$get, ...sym,
//    wasm.call, ...types.Symbol.fields.namespace.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add,
//    wasm.local$get, ...sym,
//    wasm.call, ...types.Symbol.fields.name.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add
//  ];
//});
//
//size.implement(types.Keyword, function (sym) {
//  return [
//    wasm.i32$const, ...sleb128i32(types.Keyword.size),
//    wasm.local$get, ...sym,
//    wasm.call, ...types.Keyword.fields.namespace.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add,
//    wasm.local$get, ...sym,
//    wasm.call, ...types.Keyword.fields.name.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add
//  ];
//});
//
//size.implement(types.RefsArray, function (arr) {
//  const len = this.local(wasm.i32),
//        idx = this.local(wasm.i32),
//        out = this.local(wasm.i32);
//  return [
//    wasm.i32$const, ...sleb128i32(types.RefsArray.size),
//    wasm.i32$const, ...sleb128i32(types.Array.size),
//    wasm.i32$add,
//    wasm.local$set, ...out,
//    wasm.local$get, ...arr,
//    wasm.call, ...types.RefsArray.fields.arr.uleb128,
//    wasm.call, ...types.Array.fields.length.uleb128,
//    wasm.local$set, ...len,
//    wasm.loop, wasm.void,
//      wasm.local$get, ...idx,
//      wasm.local$get, ...len,
//      wasm.i32$lt_u,
//      wasm.if, wasm.void,
//        wasm.local$get, ...arr,
//        wasm.local$get, ...idx,
//        wasm.call, ...refs_array_get.uleb128,
//        wasm.call, ...size.uleb128,
//        wasm.local$get, ...out,
//        wasm.i32$add,
//        wasm.local$set, ...out,
//        wasm.local$get, ...idx,
//        wasm.i32$const, 1,
//        wasm.i32$add,
//        wasm.local$set, ...idx,
//        wasm.br, 1,
//      wasm.end,
//    wasm.end,
//    wasm.local$get, ...out
//  ];
//});
//
//size.implement(types.PartialNode, function (node) {
//  return [
//    wasm.i32$const, ...sleb128i32(types.PartialNode.size),
//    wasm.local$get, ...node,
//    wasm.call, ...types.PartialNode.fields.arr.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add
//  ];
//});
//
//size.implement(types.FullNode, function (node) {
//  return [
//    wasm.i32$const, ...sleb128i32(types.FullNode.size),
//    wasm.local$get, ...node,
//    wasm.call, ...types.FullNode.fields.arr.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add
//  ];
//});
//
//size.implement(types.HashCollisionNode, function (node) {
//  return [
//    wasm.i32$const, ...sleb128i32(types.HashCollisionNode.size),
//    wasm.local$get, ...node,
//    wasm.call, ...types.HashCollisionNode.fields.arr.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add
//  ];
//});
//
//size.implement(types.LeafNode, function (node) {
//  return [
//    wasm.i32$const, ...sleb128i32(types.LeafNode.size),
//    wasm.local$get, ...node,
//    wasm.call, ...types.LeafNode.fields.key.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add,
//    wasm.local$get, ...node,
//    wasm.call, ...types.LeafNode.fields.val.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add
//  ];
//});
//
//size.implement(types.HashMap, function (map) {
//  return [
//    wasm.i32$const, ...sleb128i32(types.HashMap.size),
//    wasm.local$get, ...map,
//    wasm.call, ...types.HashMap.fields.root.uleb128,
//    wasm.call, ...size.uleb128,
//    wasm.i32$add
//  ];
//});

/*----------*\
|            |
| local free |
|            |
\*----------*/

const external_flag = 0x80000000,
      derived_flag = 0x40000000;

const set_local_free_derived = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {}, function (val, on) {
    const type_num = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.i32$load, 2, 0,
      wasm.local$tee, ...type_num,
      wasm.i32$const, 2,
      wasm.i32$gt_u,
      wasm.local$get, ...type_num,
      wasm.i32$const, ...sleb128i32(256),
      wasm.i32$lt_u,
      wasm.i32$and,
      wasm.if, wasm.i32,
        wasm.local$get, ...val,
        wasm.i32$const, ...sleb128i32(derived_flag),
        wasm.local$get, ...on,
        wasm.call, ...set_flag.uleb128,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  }
);

const set_local_free_external = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (val, on) {
    const type_num = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.i32$load, 2, 0,
      wasm.local$tee, ...type_num,
      wasm.i32$const, 2,
      wasm.i32$gt_u,
      wasm.local$get, ...type_num,
      wasm.i32$const, ...sleb128i32(256),
      wasm.i32$lt_u,
      wasm.i32$and,
      wasm.if, wasm.i32,
        wasm.local$get, ...val,
        wasm.i32$const, ...sleb128i32(external_flag),
        wasm.local$get, ...on,
        wasm.call, ...set_flag.uleb128,
      wasm.else,
        wasm.i32$const, 1,
      wasm.end
    ];
  }
);

const local_free_is_external = funcs.build(
  [wasm.i32], [wasm.i32], {}, function (val) {
    const type_num = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.i32$load, 2, 0,
      wasm.local$tee, ...type_num,
      wasm.i32$const, 2,
      wasm.i32$gt_u,
      wasm.local$get, ...type_num,
      wasm.i32$const, ...sleb128i32(256),
      wasm.i32$lt_u,
      wasm.i32$and,
      wasm.if, wasm.i32,
        wasm.local$get, ...val,
        wasm.i32$const, ...sleb128i32(external_flag),
        wasm.call, ...get_flag.uleb128,
      wasm.else,
        wasm.i32$const, 1,
      wasm.end,
    ];
  }
);

const local_free_is_derived = funcs.build(
  [wasm.i32], [wasm.i32], {}, function (val) {
    const type_num = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.i32$load, 2, 0,
      wasm.local$tee, ...type_num,
      wasm.i32$const, 2,
      wasm.i32$gt_u,
      wasm.local$get, ...type_num,
      wasm.i32$const, ...sleb128i32(256),
      wasm.i32$lt_u,
      wasm.i32$and,
      wasm.if, wasm.i32,
        wasm.local$get, ...val,
        wasm.i32$const, ...sleb128i32(derived_flag),
        wasm.call, ...get_flag.uleb128,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  }
);

const inc_refs_if_external_local = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { comp: "inc-refs-if-external" },
  function (src, dst) {
    return [
      wasm.local$get, ...src,
      wasm.call, ...local_free_is_external.uleb128,
      wasm.local$get, ...src,
      wasm.call, ...local_free_is_derived.uleb128,
      wasm.local$get, ...dst,
      wasm.call, ...local_free_is_external.uleb128,
      wasm.i32$eqz,
      wasm.i32$and,
      wasm.i32$or,
      wasm.if, wasm.i32,
        wasm.local$get, ...dst,
        wasm.call, ...inc_refs.uleb128,
      wasm.else,
        wasm.local$get, ...dst,
      wasm.end,
    ];
  }
);

const transfer_local_free_derived = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (src, dst) {
    return [
      wasm.local$get, ...src,
      wasm.call, ...local_free_is_external.uleb128,
      wasm.local$get, ...src,
      wasm.call, ...local_free_is_derived.uleb128,
      wasm.local$get, ...dst,
      wasm.call, ...local_free_is_external.uleb128,
      wasm.i32$eqz,
      wasm.i32$and,
      wasm.i32$or,
      wasm.if, wasm.void,
        wasm.local$get, ...dst,
        wasm.i32$const, 1,
        wasm.call, ...set_local_free_derived.uleb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...dst,
    ];
  }
);

/*--------*\
|          |
| bindings |
|          |
\*--------*/

const global_env = new_atom(empty_hash_map);

const store_binding = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [], { export: "store_binding" },
  function (nm, val, env) {
    const map = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.i32$const, 1,
      wasm.call, ...set_local_free_external.uleb128,
      wasm.drop,
      wasm.local$get, ...env,
      wasm.local$get, ...env,
      wasm.call, ...atom_swap_lock.uleb128,
      wasm.local$tee, ...map,
      wasm.local$get, ...nm,
      wasm.local$get, ...val,
      wasm.call, ...assoc.uleb128,
      wasm.call, ...atom_swap_set.uleb128,
      wasm.drop,
      wasm.local$get, ...map,
      wasm.call, ...free.uleb128
    ];
  }
);

const make_comp_func = funcs.build(
  [
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32
  ],
  [wasm.i32], { export: "make_comp_func" },
  function (
    func_num,
    i32_args,
    i64_args,
    f64_args,
    i32_res,
    i64_res,
    f64_res,
  ) {
    return [
      wasm.local$get, ...func_num,
      wasm.local$get, ...func_num,
      wasm.call, ...add_to_func_table.uleb128,
      wasm.local$get, ...i32_args,
      wasm.local$get, ...i64_args,
      wasm.local$get, ...f64_args,
      wasm.local$get, ...i32_res,
      wasm.local$get, ...i64_res,
      wasm.local$get, ...f64_res,
      wasm.call, ...get_type_idx.uleb128,
      wasm.local$get, ...i32_res,
      wasm.if, wasm.i32,
        wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.else,
        wasm.i32$const, ...sleb128i32(wasm.i64),
      wasm.end,
      wasm.local$get, ...i32_args,
      wasm.local$get, ...i64_args,
      wasm.local$get, ...f64_args,
      wasm.local$get, ...i32_res,
      wasm.local$get, ...i64_res,
      wasm.local$get, ...f64_res,
      wasm.i32$const, nil,
      wasm.call, ...types.Function2.constr.uleb128
    ];
  }
);

const store_comp_func = funcs.build(
  [
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32
  ],
  [], { export: "store_comp_func" },
  function (
    name,
    i32_args,
    i64_args,
    f64_args,
    i32_res,
    i64_res,
    f64_res,
    func_num
  ) {
    return [
      wasm.local$get, ...name,
      wasm.local$get, ...func_num,
      wasm.local$get, ...i32_args,
      wasm.local$get, ...i64_args,
      wasm.local$get, ...f64_args,
      wasm.local$get, ...i32_res,
      wasm.local$get, ...i64_res,
      wasm.local$get, ...f64_res,
      wasm.call, ...make_comp_func.uleb128,
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...store_binding.uleb128
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

for (let type_name in types) {
  const type_info = types[type_name];
  type_name = `comp.${type_name}`;
  let _ts = comp.atom_swap_lock(comp_types);
  const type = comp.Type(type_info.type_num);
  let ts = comp.conj(_ts, type);
  comp.free(_ts);
  comp.atom_swap_set(comp_types, ts);
  comp.store_binding(make_keyword(type_name), type, global_env);
  const pred = pre_new_method(
    1, 0, 0, 1, 0, 0,
    {
      comp: [type_name, "instance"],
      comp_wrapper: [wrap_result_i32_to_bool]
    },
    () => [wasm.i32$const, 0]
  );
  pred.implement(type_info, () => [wasm.i32$const, 1]);
// todo: change this and field accessors
  type_info.pred = pred;
}

/*-------*\
|         |
| methods |
|         |
\*-------*/

const methods = new_atom(empty_vector);

const impl_def_func_all_methods = funcs.build(
  [wasm.i32], [], {},
  function (tpnm) {
    const mtds = this.local(wasm.i32),
          mtd = this.local(wasm.i32),
          cnt = this.local(wasm.i32),
          idx = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(methods),
      wasm.call, ...atom_deref.uleb128,
      wasm.local$tee, ...mtds,
      wasm.call, ...count.uleb128,
      wasm.local$set, ...cnt,
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...mtds,
          wasm.local$get, ...idx,
          wasm.i32$const, nil,
          wasm.call, ...nth.uleb128,
          wasm.local$tee, ...mtd,
          wasm.call, ...types.Method.fields.num.uleb128,
          wasm.local$get, ...tpnm,
          wasm.local$get, ...mtd,
          wasm.call, ...types.Method.fields.default_func.uleb128,
          wasm.call, ...impl_method.uleb128,
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

const impl_def_func_all_types = funcs.build(
  [wasm.i32], [], { export: "impl_def_func_all_types" },
  function (mtd) {
    const tps = this.local(wasm.i32),
          mtd_num = this.local(wasm.i32),
          def_fnc = this.local(wasm.i32),
          cnt = this.local(wasm.i32),
          idx = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(comp_types),
      wasm.call, ...atom_deref.uleb128,
      wasm.local$tee, ...tps,
      wasm.call, ...count.uleb128,
      wasm.local$set, ...cnt,
      wasm.local$get, ...mtd,
      wasm.call, ...types.Method.fields.num.uleb128,
      wasm.local$set, ...mtd_num,
      wasm.local$get, ...mtd,
      wasm.call, ...types.Method.fields.default_func.uleb128,
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
          wasm.call, ...nth.uleb128,
          wasm.call, ...types.Type.fields.num.uleb128,
          wasm.local$get, ...def_fnc,
          wasm.call, ...impl_method.uleb128,
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

const store_method = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], { export: "store_method" },
  function (mtd_num, def_fnc, main_fnc) {
    const mtd = this.local(wasm.i32),
          mtds = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(methods),
      wasm.i32$const, ...sleb128i32(methods),
      wasm.call, ...atom_swap_lock.uleb128,
      wasm.local$tee, ...mtds,
      wasm.local$get, ...mtd_num,
      wasm.local$get, ...def_fnc,
      wasm.local$get, ...main_fnc,
      wasm.call, ...types.Method.constr.uleb128,
      wasm.local$tee, ...mtd,
      wasm.call, ...conj.uleb128,
      wasm.call, ...atom_swap_set.uleb128,
      wasm.drop,
      wasm.local$get, ...mtds,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...mtd
    ];
  }
);

compile();

for (const m of defined_methods) {
  comp.store_method(m.mtd_num, m.def_func.func_idx, m.func_idx);
}

function new_method (
  arg_i32, arg_i64, arg_f64,
  res_i32, res_i64, res_f64,
  opts, def_func
) {
  const out = def_mtd(
	  arg_i32, arg_i64, arg_f64,
          res_i32, res_i64, res_f64,
          opts, def_func
        ),
        mtd = comp.store_method(
          out.mtd_num,
          out.def_func.func_idx,
          out.main_func
        );
  comp.impl_def_func_all_types(mtd);
  let nm = opts.comp;
  if (nm instanceof Array) {
    nm = make_keyword(nm[0], nm[1]);
  } else if (nm) {
    nm = make_keyword("comp", nm);
  }
  if (opts.comp) comp.store_binding(nm, mtd, global_env);
  return out;
}

/*-----*\
|       |
| to_js |
|       |
\*-----*/

const to_js = new_method(1, 0, 0, 1, 0, 0, {
  export: "to_js", comp: "to-js"
});

to_js.implement(types.String, function (str) {
  return [
    wasm.local$get, ...str,
    wasm.call, ...store_string.uleb128,
    wasm.call, ...types.Object.constr.uleb128
  ];
});

/*-----------*\
|             |
| deref/reset |
|             |
\*-----------*/

// todo: should these really be methods?
//const deref = new_method(1, wasm.i32, { export: "deref", comp: "deref" });
//
//deref.implement(types.Atom, atom_deref.func_idx);

//const reset = new_method(2, wasm.i32, { comp: "reset!" });

const reset = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { comp: "reset!" },
  function (atom, val) {
    return [
      wasm.local$get, ...atom,
      wasm.local$get, ...val,
      wasm.local$get, ...atom,
      wasm.call, ...atom_swap_lock.uleb128,
      wasm.drop,
      wasm.call, ...atom_swap_set.uleb128,
    ];
  }
);

/*----------*\
|            |
| comp funcs |
|            |
\*----------*/

// todo: do same for other coll access funcs (e.g. get)

funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], { comp: "nth" },
  function (coll, n, not_found) {
    return [
      wasm.local$get, ...coll,
      wasm.local$get, ...coll,
      wasm.local$get, ...n,
      wasm.call, ...types.Int.fields.value.uleb128,
      wasm.i32$wrap_i64,
      wasm.local$get, ...not_found,
      wasm.call, ...nth.uleb128,
      wasm.call, ...inc_refs_if_external_local.uleb128
    ];
  }
);

funcs.build(
  [wasm.i32], [wasm.i32], { comp: "first" },
  function (coll) {
    return [
      wasm.local$get, ...coll,
      wasm.local$get, ...coll,
      wasm.call, ...first.uleb128,
      wasm.call, ...inc_refs_if_external_local.uleb128
    ];
  }
);

funcs.build(
  [wasm.i32], [wasm.i32], { comp: "rest" },
  function (coll) {
    return [
      wasm.local$get, ...coll,
      wasm.local$get, ...coll,
      wasm.call, ...rest.uleb128,
      wasm.call, ...transfer_local_free_derived.uleb128
    ];
  }
);

funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { comp: "cons" },
  function (val, coll) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$get, ...coll,
      wasm.call, ...to_seq.uleb128,
      wasm.call, ...inc_refs.uleb128,
      wasm.call, ...types.ConsSeq.constr.uleb128,
      wasm.call, ...types.Seq.constr.uleb128,
    ];
  }
);

funcs.build(
  [wasm.i32], [wasm.i32], { comp: "array" },
  function (len) {
    return [
      wasm.local$get, ...len,
      wasm.call, ...types.Int.fields.value.uleb128,
      wasm.i32$wrap_i64,
      wasm.call, ...refs_array_by_length.uleb128
    ];
  }
);

funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], { comp: "array-set" },
  function (arr, idx, val) {
    return [
      wasm.local$get, ...arr,
      wasm.local$get, ...idx,
      wasm.call, ...types.Int.fields.value.uleb128,
      wasm.i32$wrap_i64,
      wasm.local$get, ...val,
      wasm.call, ...refs_array_set.uleb128
    ];
  }
);

funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], { comp: "array-set-no-inc" },
  function (arr, idx, val) {
    return [
      wasm.local$get, ...arr,
      wasm.local$get, ...idx,
      wasm.call, ...types.Int.fields.value.uleb128,
      wasm.i32$wrap_i64,
      wasm.local$get, ...val,
      wasm.call, ...refs_array_set_no_inc.uleb128
    ];
  }
);

funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], { comp: "for-each" },
  function (coll, accum, start_idx, end_idx, func) {
    const out = this.local(wasm.i32);
    return [
      wasm.local$get, ...coll,
      wasm.local$get, ...accum,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$get, ...start_idx,
      wasm.call, ...types.Int.fields.value.uleb128,
      wasm.i32$wrap_i64,
      wasm.local$get, ...end_idx,
      wasm.local$get, ...start_idx,
      wasm.call, ...types.Int.fields.value.uleb128,
      wasm.i32$wrap_i64,
      wasm.local$get, ...func,
      wasm.call, ...for_each.uleb128,
      wasm.local$tee, ...out,
      wasm.local$get, ...out,
      wasm.local$get, ...accum,
      wasm.i32$eq,
      wasm.if, wasm.void,
        wasm.local$get, ...accum,
        wasm.call, ...free.uleb128,
      wasm.end
    ];
  }
);

funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { comp: "def" },
  function (name, val) {
    return [
      wasm.local$get, ...name,
      wasm.local$get, ...val,
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...store_binding.uleb128,
      wasm.local$get, ...val
    ];
  }
);

const comp_atom = funcs.build(
  [wasm.i32], [wasm.i32], { comp: "atom" },
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...types.Atom.constr.uleb128
    ];
  }
);

const namespace = new_method(
  1, 0, 0, 1, 0, 0, { comp: "namespace" }
);

function get_namespace (sym) {
  const ns = this.local(wasm.i32);
  return [
    wasm.local$get, ...sym,
    wasm.call, ...types.Symbol.fields.namespace.uleb128,
    wasm.local$tee, ...ns,
    wasm.if, wasm.i32,
      wasm.local$get, ...ns,
      wasm.local$get, ...ns,
      wasm.call, ...force_to_string.uleb128,
      wasm.local$tee, ...ns,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...ns,
      wasm.else,
        wasm.local$get, ...sym,
        wasm.local$get, ...ns,
        wasm.call, ...inc_refs_if_external_local.uleb128,
      wasm.end,
    wasm.else,
      wasm.local$get, ...ns,
    wasm.end
  ];
}

namespace.implement(types.Symbol, get_namespace); 
namespace.implement(types.Keyword, get_namespace); 

const name = new_method(1, 0, 0, 1, 0, 0, { comp: "name" });

function get_name (sym) {
  const nm = this.local(wasm.i32);
  return [
    wasm.local$get, ...sym,
    wasm.call, ...types.Symbol.fields.name.uleb128,
    wasm.local$tee, ...nm,
    wasm.local$get, ...nm,
    wasm.call, ...force_to_string.uleb128,
    wasm.local$tee, ...nm,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...nm,
    wasm.else,
      wasm.local$get, ...sym,
      wasm.local$get, ...nm,
      wasm.call, ...inc_refs_if_external_local.uleb128,
    wasm.end,
  ];
}

name.implement(types.Symbol, get_name);
name.implement(types.Keyword, get_name);

const key = new_method(1, 0, 0, 1, 0, 0, { comp: "key" });

function get_key (leaf) {
  return [
    wasm.local$get, ...leaf,
    wasm.local$get, ...leaf,
    wasm.call, ...types.LeafNode.fields.key.uleb128,
    wasm.call, ...inc_refs_if_external_local.uleb128,
  ];
}

key.implement(types.LeafNode, get_key);

const val = new_method(1, 0, 0, 1, 0, 0, { comp: "val" });

function get_val (leaf) {
  return [
    wasm.local$get, ...leaf,
    wasm.local$get, ...leaf,
    wasm.call, ...types.LeafNode.fields.val.uleb128,
    wasm.call, ...inc_refs_if_external_local.uleb128,
  ];
}

val.implement(types.LeafNode, get_val);

// todo: why not store main_func and def_func as Functions?
funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], { comp: "defmethod" },
  function (mtd_name, num_args, def_func) {
    const mtd = this.local(wasm.i32),
          mtd_func = this.local(wasm.i32),
          mtd_num = this.local(wasm.i32);
    return [
      wasm.local$get, ...mtd_name,
      wasm.i32$const, nil,
// todo: export method with opts
      // wasm.local$get, ...mtd_name,
      // // expects no namespace (use $)
      // wasm.call, ...types.Symbol.fields.name.uleb128,
      // wasm.call, ...store_string.uleb128,
      wasm.local$get, ...num_args,
      wasm.call, ...types.Int.fields.value.uleb128,
      wasm.i32$wrap_i64,
      wasm.i32$const, 0,
      wasm.i32$const, 0,
      wasm.i32$const, 1,
      wasm.i32$const, 0,
      wasm.i32$const, 0,
      wasm.call, ...new_comp_method.uleb128,
      wasm.local$set, ...mtd_num,
      wasm.local$set, ...mtd_func,
      wasm.local$get, ...mtd_num,
      wasm.local$get, ...def_func,
// todo: why not just leave as Method?
      wasm.call, ...types.Method.pred.uleb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...def_func,
        wasm.call, ...types.Method.fields.main_func.uleb128,
        wasm.call, ...types.Function.fields.func_num.uleb128,
        wasm.local$tee, ...def_func,
      wasm.else,
        wasm.local$get, ...def_func,
        wasm.call, ...types.Function.pred.uleb128,
        wasm.if, wasm.i32,
          wasm.local$get, ...def_func,
          wasm.call, ...types.Function.fields.func_num.uleb128,
          wasm.local$tee, ...def_func,
        wasm.else,
          wasm.local$get, ...def_func,
        wasm.end,
      wasm.end,
      // num_args is int literal, so won't be freed automatically
      wasm.local$get, ...num_args,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...mtd_func,
      wasm.call, ...store_method.uleb128,
      wasm.local$tee, ...mtd,
      wasm.call, ...impl_def_func_all_types.uleb128,
      wasm.local$get, ...mtd,
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...store_binding.uleb128,
      wasm.i32$const, nil
    ];
  }
);

const get_next_type_num = funcs.build(
  [], [wasm.i32], {},
  function (func) {
    const ts = this.local(wasm.i32),
          type_num = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(comp_types),
      wasm.i32$const, ...sleb128i32(comp_types),
      wasm.call, ...atom_swap_lock.uleb128,
      wasm.local$tee, ...ts,
      wasm.local$get, ...ts,
      wasm.call, ...count.uleb128,
      wasm.local$tee, ...type_num,
      wasm.call, ...types.Type.constr.uleb128,
      wasm.call, ...conj.uleb128,
      wasm.call, ...atom_swap_set.uleb128,
      wasm.drop,
      wasm.local$get, ...ts,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...type_num,
    ];
  }
);

funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { comp: "deftype" },
  function (type_name, fields) {
    const inner_constr = this.local(wasm.i32),
          outer_constr = this.local(wasm.i32),
          type_num = this.local(wasm.i32),
          type_size = this.local(wasm.i32),
          field_num = this.local(wasm.i32),
          param_num = this.local(wasm.i32),
          field_name = this.local(wasm.i32),
          get_func = this.local(wasm.i32);
    return [
      wasm.local$get, ...type_name,
      // expects no namespace (use $)
      wasm.call, ...types.Symbol.fields.name.uleb128,
      wasm.local$set, ...type_name,

      wasm.call, ...start_type.uleb128,
      wasm.local$set, ...outer_constr,
      wasm.local$set, ...inner_constr,

      wasm.call, ...get_next_type_num.uleb128,
      wasm.local$tee, ...type_num,
      wasm.call, ...impl_def_func_all_methods.uleb128,

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
      wasm.call, ...add_type_field.uleb128,
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
      wasm.call, ...add_type_field.uleb128,
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
      wasm.call, ...add_type_field.uleb128,
      wasm.local$set, ...get_func,
      wasm.local$set, ...param_num,
      wasm.local$set, ...field_num,
      wasm.local$set, ...type_size,

      wasm.loop, wasm.void,
        wasm.local$get, ...param_num,
        wasm.local$get, ...fields,
        wasm.call, ...count.uleb128,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...fields,
          wasm.local$get, ...param_num,
          wasm.i32$const, nil,
          wasm.call, ...nth.uleb128,
          wasm.call, ...types.Symbol.fields.name.uleb128,
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
          wasm.call, ...add_type_field.uleb128,
          wasm.local$set, ...get_func,
          wasm.local$set, ...param_num,
          wasm.local$set, ...field_num,
          wasm.local$set, ...type_size,

          wasm.local$get, ...type_name,
          wasm.i32$const, ...sleb128i32(cached_string("get-")),
          wasm.local$get, ...field_name,
          wasm.call, ...concat_str.uleb128,
          wasm.i32$const, 1,
          wasm.call, ...keyword.uleb128,
          wasm.i32$const, 1,
          wasm.i32$const, 0,
          wasm.i32$const, 0,
          wasm.i32$const, 1,
          wasm.i32$const, 0,
          wasm.i32$const, 0,
          wasm.local$get, ...get_func,
          wasm.call, ...store_comp_func.uleb128,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...inner_constr,
      wasm.local$get, ...outer_constr,
      wasm.local$get, ...type_size,
      wasm.local$get, ...param_num,
      wasm.i32$const, nil,
// todo: allow exporting, then remove nil
      // wasm.local$get, ...type_name,
      // wasm.call, ...store_string.uleb128,
      wasm.call, ...end_type.uleb128,
      wasm.local$set, ...type_size,
      wasm.local$set, ...param_num,
      wasm.local$set, ...outer_constr,
      wasm.local$get, ...type_name,
// todo: should be namespaced
      wasm.i32$const, ...sleb128i32(cached_string("new")),
      wasm.i32$const, 1,
      wasm.call, ...keyword.uleb128,
      wasm.local$get, ...param_num,
      wasm.i32$const, 0,
      wasm.i32$const, 0,
      wasm.i32$const, 1,
      wasm.i32$const, 0,
      wasm.i32$const, 0,
      wasm.local$get, ...outer_constr,
      wasm.call, ...store_comp_func.uleb128,
  
// todo: how to namespace this?
      wasm.i32$const, nil,
      wasm.local$get, ...type_name,
      wasm.call, ...symbol.uleb128,
      wasm.local$get, ...type_num,
      wasm.call, ...types.Type.constr.uleb128,
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...store_binding.uleb128,
      wasm.i32$const, nil
    ];
  }
);

funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], { comp: "impl" },
  function (mtd, typ, fnc) {
    return [
      wasm.local$get, ...mtd,
      wasm.call, ...types.Method.fields.num.uleb128,
      wasm.local$get, ...typ,
      wasm.call, ...types.Type.fields.num.uleb128,
      wasm.local$get, ...fnc,
      wasm.call, ...types.Function.fields.func_num.uleb128,
      wasm.call, ...impl_method.uleb128,
      wasm.i32$const, nil
    ];
  }
);

// todo: delete following
funcs.build(
  [wasm.i32], [wasm.i32], { comp: "free" },
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...free.uleb128,
      wasm.i32$const, nil
    ];
  }
);

funcs.build(
  [wasm.i32], [wasm.i32], { comp: "print-i32" },
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...print_i32.uleb128,
      wasm.i32$const, nil
    ];
  }
);

const print_coll_refs = funcs.build(
  [wasm.i32], [wasm.i32], { comp: "print-coll-refs" },
  function (coll) {
    const idx = this.local(wasm.i32),
          cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...coll,
      wasm.call, ...count.uleb128,
      wasm.local$set, ...cnt,
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...coll,
          wasm.local$get, ...idx,
          wasm.i32$const, nil,
          wasm.call, ...nth.uleb128,
          wasm.call, ...read_refs.uleb128,
          wasm.call, ...print_i32.uleb128,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...idx,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...coll
    ];
  }
);

funcs.build(
  [], [wasm.i32], { comp: "get-env" },
  function () {
    return [
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...atom_deref.uleb128
    ];
  }
);

funcs.build(
  [wasm.i32], [wasm.i32], { comp: "print-refs" },
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...read_refs.uleb128,
      wasm.call, ...print_i32.uleb128,
      wasm.local$get, ...val
    ];
  }
);

funcs.build(
  [wasm.i32], [wasm.i32], { comp: "inc-refs" },
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...inc_refs.uleb128,
    ];
  }
);

funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], { comp: "identical" },
  function (a, b) {
    return [
      wasm.local$get, ...a,
      wasm.local$get, ...b,
      wasm.i32$eq,
    ]
  }
);

funcs.build(
  [], [wasm.i32], { comp: "print-curr-func-num" },
  function () {
    return [
      wasm.call, ...print_func_num.uleb128,
      wasm.i32$const, nil
    ];
  }
);

funcs.build(
  [wasm.i32], [wasm.i32], { comp: "print-type" },
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.i32$load, 2, 0,
      wasm.call, ...print_i32.uleb128,
      wasm.i32$const, nil
    ];
  }
);

funcs.build(
  [wasm.i32], [wasm.i32], { comp: "print-mtd-func-num" },
  function (mtd) {
    return [
      wasm.local$get, ...mtd,
      wasm.call, ...types.Method.fields.main_func.uleb128,
      wasm.call, ...types.Function.fields.func_num.uleb128,
      wasm.call, ...print_i32.uleb128,
      wasm.i32$const, nil
    ];
  }
);

funcs.build(
  [wasm.i32], [wasm.i32], { comp: "print-func-num" },
  function (func) {
    return [
      wasm.local$get, ...func,
      wasm.call, ...types.Function.fields.func_num.uleb128,
      wasm.call, ...print_i32.uleb128,
      wasm.local$get, ...func,
    ];
  }
);

funcs.build(
  [wasm.i32], [wasm.i32], { comp: "print-type" },
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.i32$load, 2, 0,
      wasm.call, ...print_i32.uleb128,
      wasm.i32$const, nil
    ];
  }
);

funcs.build(
  [wasm.i64], [wasm.i32], { comp: "print-i64" },
  function (val) {
    return [
      wasm.local$get, ...val,
      wasm.call, ...print_i64.uleb128,
      wasm.i32$const, nil
    ];
  }
);

/*----------------*\
|                  |
| load from syntax |
|                  |
\*----------------*/

const load_from_syntax = new_method(
  1, 0, 0, 1, 0, 0, {}, (val) => [wasm.local$get, ...val]
);

load_from_syntax.implement(types.Symbol, function (sym) {
  const nsnm = this.local(wasm.i32);
  return [
    wasm.local$get, ...sym,
    wasm.call, ...types.Symbol.pred.uleb128,
    wasm.if, wasm.void,
      wasm.local$get, ...sym,
      wasm.call, ...types.Symbol.fields.namespace.uleb128,
      wasm.local$tee, ...nsnm,
      wasm.if, wasm.void,
        wasm.local$get, ...sym,
        wasm.i32$const, ...sleb128i32(types.Symbol.fields.namespace.offset),
        wasm.i32$add,
        wasm.local$get, ...nsnm,
        wasm.call, ...force_to_string.uleb128,
        wasm.i32$store, 2, 0,
      wasm.end,
      wasm.local$get, ...nsnm,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...sym,
      wasm.i32$const, ...sleb128i32(types.Symbol.fields.name.offset),
      wasm.i32$add,
      wasm.local$get, ...sym,
      wasm.call, ...types.Symbol.fields.name.uleb128,
      wasm.call, ...force_to_string.uleb128,
      wasm.i32$store, 2, 0,
    wasm.end,
    wasm.local$get, ...sym,
  ];
});

/*---------*\
|           |
| emit code |
|           |
\*---------*/

const lookup_global = funcs.build(
  [wasm.i32], [wasm.i32], { export: "lookup_global" },
  function (var_name) {
    return [
      wasm.i32$const, ...sleb128i32(global_env),
      wasm.call, ...atom_deref.uleb128,
      wasm.local$get, ...var_name,
      wasm.i32$const, nil,
      wasm.call, ...get.uleb128,
    ];
  }
);

const emit_code_default = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32, wasm.i32], {},
  function (val, func, env) {
    const nsnm = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
// todo: shouldn't this be required?
      //wasm.call, ...load_from_syntax.uleb128,
      //wasm.local$tee, ...val,
// todo: why inc_refs? set_local_free should prevent freeing
      wasm.call, ...inc_refs.uleb128,
      wasm.i32$const, 1,
      wasm.call, ...set_local_free_external.uleb128,
      wasm.drop,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...val,
      wasm.call, ...append_varsint32.uleb128,
      wasm.drop,
      wasm.i32$const, 2,
      wasm.i32$const, nil,
    ];
  }
);

// todo: double return from methods, then return env so we don't need to use atoms
const emit_code = new_method(3, 0, 0, 2, 0, 0, {}, emit_code_default);

const add_to_locals_to_free = funcs.build(
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
        wasm.call, ...get.uleb128,
        wasm.local$tee, ...atm,
        wasm.local$get, ...atm,
        wasm.call, ...atom_swap_lock.uleb128,
        wasm.local$get, ...loc,
        wasm.call, ...array_push_i32.uleb128,
        wasm.local$tee, ...arr,
        wasm.call, ...atom_swap_set.uleb128,
        wasm.drop,
        wasm.local$get, ...arr,
        wasm.call, ...free.uleb128,
      wasm.end,
      wasm.local$get, ...loc
   ];
  }
);

const inc_locals = funcs.build(
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
        wasm.call, ...add_local.uleb128,
        wasm.drop,
      wasm.else,
        wasm.local$get, ...func,
        wasm.local$get, ...loc_typ,
        wasm.call, ...add_param.uleb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("locals")),
      wasm.i32$const, nil,
      wasm.call, ...get.uleb128,
      wasm.local$tee, ...locals,
      wasm.local$get, ...locals,
      wasm.call, ...atom_swap_lock.uleb128,
      wasm.local$tee, ...arr,
      wasm.local$get, ...arr,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$set, ...cnt,
      wasm.local$get, ...loc_typ,
      wasm.call, ...array_push_i32.uleb128,
      wasm.local$tee, ...arr,
      wasm.call, ...atom_swap_set.uleb128,
      wasm.drop,
      wasm.local$get, ...arr,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...cnt,
    ];
  }
);

const stage_val_to_free = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (func, env, type) {
    const loc_num = this.local(wasm.i32);
    return [
      wasm.local$get, ...type,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...func,
        //wasm.i32$const, ...sleb128i32(wasm.call),
        //wasm.call, ...append_code.uleb128,
        //wasm.i32$const, ...inc_refs.sleb128,
        //wasm.call, ...append_varsint32.uleb128,
        wasm.i32$const, ...sleb128i32(wasm.local$tee),
        wasm.call, ...append_code.uleb128,
        wasm.local$get, ...env,
        wasm.local$get, ...func,
        wasm.i32$const, 1,
        wasm.i32$const, ...sleb128i32(wasm.i32),
        wasm.call, ...inc_locals.uleb128,
        wasm.local$tee, ...loc_num,
        wasm.local$get, ...env,
        wasm.i32$const, ...sleb128i32(wasm.i32),
        wasm.call, ...add_to_locals_to_free.uleb128,
        wasm.call, ...append_varuint32.uleb128,
        wasm.drop,
        wasm.local$get, ...loc_num,
      wasm.else,
        wasm.i32$const, ...sleb128i32(-1),
      wasm.end
    ];
  }
);

const get_locals_array = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (env) {
   return [
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("locals")),
      wasm.i32$const, nil,
      wasm.call, ...get.uleb128,
      wasm.call, ...atom_deref.uleb128
   ];
  }
);

const get_locals_to_free = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (env) {
    return [
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("locals-to-free")),
      wasm.i32$const, nil,
      wasm.call, ...get.uleb128,
      wasm.call, ...atom_deref.uleb128
    ];
  }
);

const is_num64 = new_method(2, 0, 0, 1, 0, 0, {}, function (val, env) {
  return [wasm.i32$const, 0];
});

is_num64.implement(types.Symbol, function (sym, env) {
  const loc_num = this.local(wasm.i32),
        typ = this.local(wasm.i32);
  return [
    wasm.local$get, ...env,
    wasm.local$get, ...sym,
    wasm.i32$const, nil,
    wasm.call, ...get.uleb128,
    wasm.local$tee, ...loc_num,
    wasm.if, wasm.i32,
      wasm.local$get, ...env,
      wasm.call, ...get_locals_array.uleb128,
      wasm.local$get, ...loc_num,
      wasm.call, ...types.Int.fields.value.uleb128,
      wasm.i32$wrap_i64,
      wasm.call, ...array_get_i32.uleb128,
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
    wasm.i32$const, 0,
    //wasm.local$get, ...list,
    //wasm.call, ...first.uleb128,
    //wasm.local$tee, ...sym,
    //wasm.call, ...types.Symbol.pred.uleb128,
    //wasm.if, wasm.i32,
    //  wasm.local$get, ...sym,
    //  wasm.i32$const, ...sleb128i32(make_symbol("set-local")),
    //  wasm.i32$eq,
    //  wasm.if, wasm.i32,
    //    wasm.local$get, ...list,
    //    wasm.call, ...rest.uleb128,
    //    wasm.call, ...first.uleb128,
    //    wasm.local$get, ...env,
    //    wasm.call, ...is_num64.uleb128,
    //  wasm.else,
    //    wasm.local$get, ...sym,
    //    wasm.call, ...types.Symbol.fields.namespace.uleb128,
    //    wasm.local$tee, ...ns,
    //    wasm.if, wasm.i32,
    //      wasm.local$get, ...ns,
    //      wasm.i32$const, ...sleb128i32(cached_string("i64")),
    //      wasm.call, ...eq.uleb128,
    //      wasm.if, wasm.i32,
    //        wasm.i32$const, ...sleb128i32(wasm.i64),
    //      wasm.else,
    //        wasm.local$get, ...ns,
    //        wasm.i32$const, ...sleb128i32(cached_string("f64")),
    //        wasm.call, ...eq.uleb128,
    //        wasm.if, wasm.i32,
    //          wasm.i32$const, ...sleb128i32(wasm.f64),
    //        wasm.else,
    //          wasm.i32$const, 0,
    //        wasm.end,
    //      wasm.end,
    //    wasm.else,
    //      wasm.i32$const, 0,
    //    wasm.end,
    //    wasm.local$tee, ...result,
    //    wasm.if, wasm.i32,
    //      wasm.local$get, ...result,
    //    wasm.else,
    //      wasm.local$get, ...sym,
    //      wasm.call, ...lookup_global.uleb128,
    //      wasm.local$tee, ...func_record,
    //      wasm.call, ...types.Function.pred.uleb128,
    //      wasm.if, wasm.i32,
    //        wasm.local$get, ...func_record,
    //        wasm.call, ...types.Function.fields.result.uleb128,
    //        wasm.local$tee, ...result,
    //        wasm.i32$const, ...sleb128i32(wasm.i64),
    //        wasm.i32$eq,
    //        wasm.local$get, ...result,
    //        wasm.i32$const, ...sleb128i32(wasm.f64),
    //        wasm.i32$eq,
    //        wasm.i32$or,
    //        wasm.if, wasm.i32,
    //          wasm.local$get, ...result,
    //        wasm.else,
    //          wasm.i32$const, 0,
    //        wasm.end,
    //      wasm.else,
    //        wasm.i32$const, 0,
    //      wasm.end,
    //    wasm.end,
    //  wasm.end,
    //wasm.else,
    //  wasm.i32$const, 0,
    //wasm.end
  ];
});

const emit_local_val = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32], {},
  function (form, func, env) {
    const type = this.local(wasm.i32),
          is_new = this.local(wasm.i32),
          local_idx = this.local(wasm.i32);
    return [
      wasm.local$get, ...form,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...emit_code.uleb128,
      wasm.drop,
      wasm.local$tee, ...type,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...env,
        wasm.call, ...get_locals_array.uleb128,
        wasm.call, ...types.Array.fields.length.uleb128,
        wasm.i32$const, 1,
        wasm.i32$sub,
      wasm.else,
        wasm.local$get, ...type,
        wasm.i32$const, 1,
        wasm.i32$eq,
        wasm.local$get, ...type,
        wasm.i32$const, 2,
        wasm.i32$eq,
        wasm.i32$or,
        wasm.if, wasm.void,
          wasm.i32$const, ...sleb128i32(wasm.i32),
          wasm.local$set, ...type,
        wasm.end,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.local$tee),
        wasm.call, ...append_code.uleb128,
        wasm.local$get, ...env,
        wasm.local$get, ...func,
        wasm.i32$const, 1,
        wasm.local$get, ...type,
        wasm.call, ...inc_locals.uleb128,
        wasm.local$tee, ...local_idx,
        wasm.call, ...append_varuint32.uleb128,
        wasm.drop,
        wasm.local$get, ...local_idx,
      wasm.end,
      wasm.local$get, ...type
    ];
  }
);

emit_code.implement(types.Symbol, function (sym, func, env) {
  const bdg_val = this.local(wasm.i32),
        result = this.local(wasm.i32);
  return [
    wasm.local$get, ...env,
    wasm.local$get, ...sym,
    wasm.i32$const, nil,
    wasm.call, ...get.uleb128,
    wasm.local$tee, ...bdg_val,
    wasm.if, wasm.i32,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.local$get),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...bdg_val,
      wasm.call, ...types.Int.fields.value.uleb128,
      wasm.i32$wrap_i64,
      wasm.call, ...append_varuint32.uleb128,
      wasm.drop,
      wasm.local$get, ...sym,
      wasm.local$get, ...env,
      wasm.call, ...is_num64.uleb128,
      wasm.local$tee, ...result,
      wasm.if, wasm.i32,
        wasm.local$get, ...result,
      wasm.else,
        wasm.i32$const, 2,
      wasm.end,
    wasm.else,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...sym,
      wasm.call, ...sym_to_kw.uleb128,
      wasm.call, ...lookup_global.uleb128,
	  //wasm.local$tee, ...sym,
	  //wasm.local$get, ...sym,
	  //wasm.call, ...print_i32.uleb128,
      wasm.call, ...append_varsint32.uleb128,
      //wasm.local$get, ...sym,
      //wasm.local$get, ...func,
      //wasm.local$get, ...env,
      //wasm.call, ...add_global_reference.uleb128,
      //wasm.local$get, ...func,
      //wasm.i32$const, ...sleb128i32(wasm.i32$const),
      //wasm.call, ...append_code.uleb128,
      //wasm.i32$const, 0,
      //wasm.call, ...append_varsint32.uleb128,
      wasm.drop,
      wasm.i32$const, 2,
    wasm.end,
    wasm.local$get, ...env,
    wasm.i32$const, ...sleb128i32(make_keyword("is-num64")),
    wasm.i32$const, nil,
    wasm.call, ...get.uleb128,
    wasm.i32$const, ...sleb128i32(comp_true),
    wasm.i32$eq,
    wasm.if, wasm.void,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.call),
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, ...sleb128i32(types.Int.fields.value.func_idx),
      wasm.call, ...append_varuint32.uleb128,
      wasm.drop,
    wasm.end,
    wasm.i32$const, nil
  ];
});

// todo: still need?
const get_sig_type = funcs.build(
  [wasm.i32], [wasm.i32, wasm.i32], {},
  function (p) {
    const curr_type = this.local(wasm.i32);
    return [
      wasm.local$get, ...p,
      wasm.call, ...types.Metadata.pred.uleb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...p,
        wasm.call, ...types.Metadata.fields.meta.uleb128,
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
            wasm.call, ...types.Exception.constr.uleb128,
            wasm.throw, 0,
          wasm.end,
        wasm.end,
        wasm.local$get, ...p,
        wasm.call, ...types.Metadata.fields.data.uleb128,
        wasm.call, ...inc_refs.uleb128,
        wasm.local$set, ...p,
        wasm.local$get, ...p,
        wasm.call, ...free.uleb128,
      wasm.else,
        wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.end,
      wasm.local$get, ...p
    ];
  }
);

const new_env = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (prev_env) {
    const addr = this.local(wasm.i32),
          offset = this.local(wasm.i32),
          env = this.local(wasm.i32),
          func = this.local(wasm.i32),
          atom = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(empty_hash_map),
      wasm.i32$const, ...sleb128i32(make_keyword("locals")),
      wasm.i32$const, 0,
      wasm.call, ...array_by_length.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...types.Atom.constr.uleb128,
      wasm.local$tee, ...atom,
      wasm.call, ...assoc.uleb128,
      wasm.local$get, ...atom,
      wasm.call, ...free.uleb128,
      wasm.local$tee, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("compile")),
      wasm.i32$const, nil,
      wasm.call, ...comp_atom.uleb128,
      wasm.call, ...assoc.uleb128,
      wasm.local$get, ...env,
      wasm.call, ...free.uleb128,
      wasm.local$tee, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("locals-to-free")),
      wasm.i32$const, 0,
      wasm.call, ...array_by_length.uleb128,
      wasm.i32$const, 0,
      wasm.call, ...types.Atom.constr.uleb128,
      wasm.local$tee, ...atom,
      wasm.call, ...assoc.uleb128,
      wasm.local$get, ...atom,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...env,
      wasm.call, ...free.uleb128,
    ];
  }
);

// todo: set_external on scope variables
const add_scope = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32], {},
  function (outer_func, inner_func, outer_env, inner_env, scope, local_idx) {
    const cnt = this.local(wasm.i32),
          idx = this.local(wasm.i32),
          ref = this.local(wasm.i32),
          scope2 = this.local(wasm.i32),
          recur_local = this.local(wasm.i32),
          scope_local = this.local(wasm.i32);
    return [
      wasm.local$get, ...scope,
      wasm.call, ...count.uleb128,
      wasm.local$tee, ...cnt,
      wasm.if, wasm.void,
        wasm.i32$const, ...sleb128i32(make_symbol("comp", "list")),
        wasm.local$get, ...scope,
        wasm.call, ...cons.uleb128,
        wasm.local$tee, ...scope2,
        wasm.local$get, ...outer_func,
        wasm.local$get, ...outer_env,
        wasm.call, ...emit_code.uleb128,
        wasm.drop,
        wasm.drop,
        wasm.local$get, ...scope2,
        wasm.call, ...free.uleb128,
// todo: already has variable from compiling list
        wasm.local$get, ...outer_func,
        wasm.i32$const, ...sleb128i32(wasm.local$set),
        wasm.call, ...append_code.uleb128,
        wasm.local$get, ...outer_env,
        wasm.local$get, ...outer_func,
        wasm.i32$const, 1,
        wasm.i32$const, ...sleb128i32(wasm.i32),
        wasm.call, ...inc_locals.uleb128,
        wasm.local$tee, ...scope_local,
        wasm.call, ...append_varuint32.uleb128,
        wasm.drop,
        wasm.local$get, ...local_idx,
        wasm.i32$const, 1,
        wasm.i32$sub,
        wasm.local$set, ...recur_local,
        wasm.loop, wasm.void,
          wasm.local$get, ...idx,
          wasm.local$get, ...cnt,
          wasm.i32$lt_u,
          wasm.if, wasm.void,
            wasm.local$get, ...inner_func,
            wasm.i32$const, ...sleb128i32(wasm.local$get),
            wasm.call, ...append_code.uleb128,
            wasm.local$get, ...recur_local,
            wasm.call, ...append_varsint32.uleb128,
            wasm.i32$const, ...sleb128i32(wasm.call),
            wasm.call, ...append_code.uleb128,
            wasm.i32$const, ...sleb128i32(types.Function.fields.scope.func_idx),
            wasm.call, ...append_varuint32.uleb128,
            wasm.i32$const, ...sleb128i32(wasm.i32$const),
            wasm.call, ...append_code.uleb128,
            wasm.local$get, ...idx,
            wasm.call, ...append_varsint32.uleb128,
            wasm.i32$const, ...sleb128i32(wasm.i32$const),
            wasm.call, ...append_code.uleb128,
            wasm.i32$const, nil,
            wasm.call, ...append_varsint32.uleb128,
            wasm.i32$const, ...sleb128i32(wasm.call),
            wasm.call, ...append_code.uleb128,
            wasm.i32$const, ...nth.sleb128,
            wasm.call, ...append_varuint32.uleb128,
            wasm.i32$const, ...sleb128i32(wasm.local$set),
            wasm.call, ...append_code.uleb128,
            wasm.local$get, ...local_idx,
            wasm.call, ...append_varuint32.uleb128,
            wasm.drop,
            wasm.local$get, ...inner_env,
            wasm.local$get, ...inner_func,
            wasm.i32$const, 1,
            wasm.i32$const, ...sleb128i32(wasm.i32),
            wasm.call, ...inc_locals.uleb128,
            wasm.drop,
            wasm.local$get, ...inner_env,
            wasm.local$get, ...scope,
            wasm.local$get, ...idx,
            wasm.i32$const, nil,
            wasm.call, ...nth.uleb128,
            wasm.local$tee, ...ref,
            wasm.local$get, ...local_idx,
            wasm.i64$extend_i32_u,
            wasm.call, ...types.Int.constr.uleb128,
            wasm.call, ...assoc.uleb128,
            wasm.local$get, ...inner_env,
            wasm.call, ...free.uleb128,
            wasm.local$set, ...inner_env,
            wasm.local$get, ...idx,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...idx,
            wasm.local$get, ...local_idx,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$tee, ...local_idx,
            wasm.br, 1,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.local$get, ...scope_local,
      wasm.local$get, ...inner_env,
    ];
  }
);

const comp_func_set_params = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32,
    wasm.i32
  ],
  {},
  function (outer_func, inner_func, params, scope, outer_env, inner_env) {
    const curr_param = this.local(wasm.i32),
          curr_type = this.local(wasm.i32),
          loc_num = this.local(wasm.i32),
          param_count = this.local(wasm.i32),
          param_index = this.local(wasm.i32),
          result = this.local(wasm.i32),
          i32_count = this.local(wasm.i32),
          i64_count = this.local(wasm.i32),
          f64_count = this.local(wasm.i32);
    return [
      wasm.local$get, ...inner_func,
      wasm.local$get, ...params,
// todo: add name & type to config map
      wasm.call, ...get_sig_type.uleb128,
      wasm.local$set, ...params,
      wasm.local$tee, ...result,
      wasm.call, ...add_result.uleb128,
      wasm.drop,
      wasm.local$get, ...params,
      wasm.call, ...count.uleb128,
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
            wasm.call, ...nth.uleb128,
            wasm.call, ...get_sig_type.uleb128,
            wasm.local$set, ...curr_param,
            wasm.local$set, ...curr_type,
            // stage to free:
            wasm.local$get, ...inner_env,
            wasm.local$get, ...inner_env,
            wasm.local$get, ...curr_param,
            wasm.local$get, ...param_index,
            wasm.i64$extend_i32_u,
            wasm.call, ...types.Int.constr.uleb128,
            wasm.local$tee, ...loc_num,
            wasm.call, ...assoc.uleb128,
            wasm.local$get, ...loc_num,
            wasm.call, ...free.uleb128,
            wasm.local$tee, ...inner_env,
            wasm.local$get, ...inner_func,
            wasm.i32$const, 0,
            wasm.local$get, ...curr_type,
            wasm.call, ...inc_locals.uleb128,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...param_index,
            // free env
            wasm.call, ...free.uleb128,
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
      wasm.local$get, ...params,
      wasm.local$get, ...scope,
      wasm.local$get, ...outer_func,
      wasm.local$get, ...inner_func,
      wasm.local$get, ...outer_env,
      wasm.local$get, ...inner_env,
      wasm.local$get, ...scope,
      wasm.local$get, ...param_index,
      wasm.call, ...add_scope.uleb128,
      wasm.local$get, ...result,
      wasm.local$get, ...i32_count,
      wasm.local$get, ...i64_count,
      wasm.local$get, ...f64_count
    ];
  }
);

let special_forms = empty_hash_map;

function def_special_form (nm, fn) {
  const sf = special_forms,
        sym = make_symbol("comp", nm);
  if (fn instanceof Function) fn = funcs.build(
    [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {}, fn
  );
  special_forms = comp.assoc(
    special_forms, sym,
    comp.make_comp_func(fn.func_idx, 3, 0, 0, 1, 0, 0)
  );
  comp.free(sf);
}

const comp_func_add_local = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (func, env, bdg, val) {
    const typ = this.local(wasm.i32),
          local_idx = this.local(wasm.i32);
    return [
      wasm.local$get, ...val,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...emit_local_val.uleb128,
      wasm.drop,
      wasm.local$set, ...local_idx,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.drop),
      wasm.call, ...append_code.uleb128,
      wasm.drop,
      wasm.local$get, ...env,
      wasm.local$get, ...bdg,
      wasm.call, ...inc_refs.uleb128,
      wasm.local$get, ...local_idx,
      wasm.i64$extend_i32_u,
      wasm.call, ...types.Int.constr.uleb128,
      wasm.local$tee, ...local_idx,
      wasm.call, ...assoc.uleb128,
      wasm.local$get, ...local_idx,
      wasm.call, ...free.uleb128
    ];
  }
);

const emit_func_call = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (func, env, head, args, is_mtd) {
    const cnt = this.local(wasm.i32),
          idx = this.local(wasm.i32),
          inner_env = this.local(wasm.i32),
          temp_env = this.local(wasm.i32),
          func_record = this.local(wasm.i32),
          i32_cnt = this.local(wasm.i32),
          i64_cnt = this.local(wasm.i32),
          f64_cnt = this.local(wasm.i32),
          func_local = this.local(wasm.i32),
          result = this.local(wasm.i32),
          func_num = this.local(wasm.i32);
    return [
      wasm.local$get, ...head,
      wasm.call, ...types.Symbol.pred.uleb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...env,
        wasm.local$get, ...head,
        wasm.i32$const, nil,
        wasm.call, ...get.uleb128,
        wasm.if, wasm.i32,
          wasm.i32$const, 0,
        wasm.else,
          wasm.local$get, ...head,
          wasm.call, ...sym_to_kw.uleb128,
          wasm.call, ...lookup_global.uleb128,
        wasm.end,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end,
      wasm.local$tee, ...func_record,
      wasm.if, wasm.void,
        wasm.local$get, ...func_record,
        wasm.call, ...types.Method.pred.uleb128,
        wasm.if, wasm.i32,
          wasm.local$get, ...func_record,
          wasm.call, ...types.Method.fields.main_func.uleb128,
        wasm.else,
          wasm.local$get, ...func_record,
        wasm.end,
        wasm.local$tee, ...func_record,
        wasm.call, ...types.Function.fields.i32_params.uleb128,
        wasm.local$set, ...i32_cnt,
        wasm.local$get, ...func_record,
        wasm.call, ...types.Function.fields.i64_params.uleb128,
        wasm.local$set, ...i64_cnt,
        wasm.local$get, ...func_record,
        wasm.call, ...types.Function.fields.f64_params.uleb128,
        wasm.local$set, ...f64_cnt,
      wasm.end,
      wasm.local$get, ...args,
      wasm.call, ...count.uleb128,
      wasm.local$tee, ...cnt,
      wasm.if, wasm.void,
        wasm.local$get, ...env,
        wasm.local$set, ...inner_env,
        wasm.loop, wasm.void,
          wasm.local$get, ...idx,
          wasm.local$get, ...cnt,
          wasm.i32$lt_u,
          wasm.if, wasm.void,
            wasm.local$get, ...args,
            wasm.local$get, ...idx,
            wasm.i32$const, nil,
            wasm.call, ...nth.uleb128,
            wasm.local$get, ...func,
            wasm.local$get, ...i32_cnt,
            wasm.if, wasm.i32,
              wasm.local$get, ...i32_cnt,
              wasm.i32$const, 1,
              wasm.i32$sub,
              wasm.local$set, ...i32_cnt,
              wasm.local$get, ...inner_env,
            wasm.else,
              wasm.local$get, ...i64_cnt,
              wasm.if, wasm.i32,
                wasm.local$get, ...i64_cnt,
                wasm.i32$const, 1,
                wasm.i32$sub,
                wasm.local$set, ...i64_cnt,
                wasm.local$get, ...inner_env,
                wasm.i32$const, ...sleb128i32(make_keyword("is-num64")),
                wasm.i32$const, ...sleb128i32(comp_true),
                wasm.call, ...assoc.uleb128,
              wasm.else,
                wasm.local$get, ...f64_cnt,
                wasm.if, wasm.i32,
                  wasm.local$get, ...f64_cnt,
                  wasm.i32$const, 1,
                  wasm.i32$sub,
                  wasm.local$set, ...f64_cnt,
                  wasm.local$get, ...inner_env,
                  wasm.i32$const, ...sleb128i32(make_keyword("is-num64")),
                  wasm.i32$const, ...sleb128i32(comp_false),
                  wasm.call, ...assoc.uleb128,
                wasm.else,
                  wasm.local$get, ...inner_env,
                wasm.end,
              wasm.end,
            wasm.end,
            wasm.local$tee, ...temp_env,
            wasm.call, ...emit_code.uleb128,
            wasm.drop,
            wasm.local$get, ...temp_env,
            wasm.local$get, ...inner_env,
            wasm.i32$ne,
            wasm.if, wasm.void,
              wasm.local$get, ...inner_env,
              wasm.local$get, ...env,
              wasm.i32$ne,
              wasm.if, wasm.void,
                wasm.local$get, ...inner_env,
                wasm.call, ...free.uleb128,
              wasm.end,
              wasm.local$get, ...temp_env,
              wasm.local$set, ...inner_env,
            wasm.end,
            wasm.local$get, ...idx,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.local$set, ...idx,
            wasm.br, 1,
          wasm.end,
        wasm.end,
      wasm.end,
      wasm.local$get, ...func_record,
      wasm.if, wasm.void,
        wasm.local$get, ...is_mtd,
        wasm.i32$eqz,
        wasm.if, wasm.void,
          wasm.local$get, ...func,
          wasm.i32$const, ...sleb128i32(wasm.i32$const),
          wasm.call, ...append_code.uleb128,
          wasm.local$get, ...func_record,
          wasm.call, ...append_varsint32.uleb128,
          wasm.drop,
        wasm.end,
        wasm.local$get, ...func_record,
        wasm.call, ...types.Function.fields.result.uleb128,
        wasm.local$set, ...result,
        wasm.local$get, ...func_record,
        wasm.call, ...types.Function.fields.func_num.uleb128,
        wasm.local$set, ...func_num,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.uleb128,
        wasm.local$get, ...func_num,
        wasm.call, ...append_varuint32.uleb128,
        wasm.drop,
      wasm.else,
// todo: we know method name with call-mtd
// todo: implement call-func
        wasm.local$get, ...head,
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.call, ...emit_code.uleb128,
        wasm.drop,
        wasm.local$set, ...result,
        wasm.local$get, ...is_mtd,
        wasm.if, wasm.void,
          wasm.local$get, ...func,
          wasm.i32$const, ...sleb128i32(wasm.call),
          wasm.call, ...append_code.uleb128,
          wasm.i32$const, ...sleb128i32(types.Method.fields.main_func.func_idx),
          wasm.call, ...append_varuint32.uleb128,
          wasm.drop,
        wasm.else,
          wasm.local$get, ...func,
          wasm.i32$const, ...sleb128i32(wasm.local$tee),
          wasm.call, ...append_code.uleb128,
          wasm.local$get, ...env,
          wasm.local$get, ...func,
          wasm.i32$const, 1,
          wasm.i32$const, ...sleb128i32(wasm.i32),
          wasm.call, ...inc_locals.uleb128,
          wasm.local$tee, ...func_local,
          wasm.call, ...append_varuint32.uleb128,
          wasm.i32$const, ...sleb128i32(wasm.local$get),
          wasm.call, ...append_code.uleb128,
          wasm.local$get, ...func_local,
          wasm.call, ...append_varuint32.uleb128,
          wasm.drop,
          wasm.local$get, ...cnt,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.local$set, ...cnt,
        wasm.end,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.uleb128,
        wasm.i32$const, ...sleb128i32(types.Function.fields.tbl_idx.func_idx),
        wasm.call, ...append_varuint32.uleb128,
        wasm.i32$const, ...sleb128i32(wasm.call_indirect),
        wasm.call, ...append_code.uleb128,
        wasm.local$get, ...cnt,
        wasm.i32$const, 0,
        wasm.i32$const, 0,
        wasm.i32$const, 1,
        wasm.i32$const, 0,
        wasm.i32$const, 0,
        wasm.call, ...get_type_idx.uleb128,
        wasm.call, ...append_varuint32.uleb128,
        wasm.i32$const, 0,
        wasm.call, ...append_varuint32.uleb128,
        wasm.drop,
        wasm.i32$const, ...sleb128i32(wasm.i32),
        wasm.local$set, ...result,
      wasm.end,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.local$get, ...result,
      wasm.call, ...stage_val_to_free.uleb128,
      wasm.drop,
      wasm.local$get, ...result
    ];
  }
);

def_special_form("list", function (fn, args, env) {
  const arr = this.local(wasm.i32),
        cnt = this.local(wasm.i32),
        idx = this.local(wasm.i32);
  return [
    wasm.local$get, ...fn,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...args,
    wasm.call, ...count.uleb128,
    wasm.local$tee, ...cnt,
    wasm.call, ...append_varsint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.call),
    wasm.call, ...append_code.uleb128,
    wasm.i32$const, ...refs_array_by_length.sleb128,
    wasm.call, ...append_varuint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.local$tee),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...env,
    wasm.local$get, ...fn,
    wasm.i32$const, 1,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.call, ...inc_locals.uleb128,
    wasm.local$tee, ...arr,
    wasm.call, ...append_varuint32.uleb128,
    wasm.loop, wasm.void,
      wasm.local$get, ...idx,
      wasm.local$get, ...cnt,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...fn,
        wasm.i32$const, ...sleb128i32(wasm.i32$const),
        wasm.call, ...append_code.uleb128,
        wasm.local$get, ...idx,
        wasm.call, ...append_varsint32.uleb128,
        wasm.drop,
        wasm.local$get, ...args,
        wasm.local$get, ...idx,
        wasm.i32$const, nil,
        wasm.call, ...nth.uleb128,
        wasm.local$get, ...fn,
        wasm.local$get, ...env,
        wasm.call, ...emit_code.uleb128,
        wasm.drop,
        wasm.drop,
        wasm.local$get, ...fn,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.uleb128,
        wasm.i32$const, ...refs_array_set.sleb128,
        wasm.call, ...append_varuint32.uleb128,
        wasm.drop,
        wasm.local$get, ...idx,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.local$set, ...idx,
        wasm.br, 1,
      wasm.end,
    wasm.end,
    wasm.i32$const, ...sleb128i32(wasm.call),
    wasm.call, ...append_code.uleb128,
    wasm.i32$const, ...to_seq.sleb128,
    wasm.call, ...append_varuint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.local$get),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...arr,
    wasm.call, ...append_varuint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.call),
    wasm.call, ...append_code.uleb128,
    wasm.i32$const, ...free.sleb128,
    wasm.call, ...append_varuint32.uleb128,
    wasm.local$get, ...env,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.call, ...stage_val_to_free.uleb128,
    wasm.drop,
    wasm.i32$const, 2
  ];
});

def_special_form("call-mtd", function (fn, args, env) {
  return [
    wasm.local$get, ...fn,
    wasm.local$get, ...env,
    wasm.local$get, ...args,
    wasm.call, ...first.uleb128,
    wasm.local$get, ...args,
    wasm.call, ...rest.uleb128,
    wasm.local$tee, ...args,
    wasm.i32$const, 1,
    wasm.call, ...emit_func_call.uleb128,
    wasm.local$get, ...args,
    wasm.call, ...free.uleb128,
  ];
});

def_special_form("compile", function (fn, args, env) {
  const compile_flag = this.local(wasm.i32);
  return [
    wasm.local$get, ...env,
    wasm.i32$const, ...sleb128i32(make_keyword("compile")),
    wasm.i32$const, nil,
    wasm.call, ...get.uleb128,
    wasm.local$tee, ...compile_flag,
    wasm.local$get, ...compile_flag,
    wasm.call, ...atom_swap_lock.uleb128,
    wasm.drop,
    wasm.i32$const, ...sleb128i32(comp_true),
    wasm.call, ...atom_swap_set.uleb128,
    wasm.drop,
    wasm.local$get, ...fn,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.uleb128,
    wasm.i32$const, 0,
    wasm.call, ...append_varsint32.uleb128,
    wasm.drop,
    wasm.i32$const, 2
  ];
});

// here
def_special_form("let", function (func, forms, env) {
  const bdgs = this.local(wasm.i32),
        bdgs_cnt = this.local(wasm.i32),
        bdg_idx = this.local(wasm.i32);
  return [
    wasm.local$get, ...forms,
    wasm.call, ...first.uleb128,
    wasm.local$tee, ...bdgs,
    wasm.call, ...count.uleb128,
    wasm.local$tee, ...bdgs_cnt,
    wasm.if, wasm.void,
      wasm.local$get, ...env,
      wasm.call, ...inc_refs.uleb128,
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
          wasm.call, ...nth.uleb128,
          wasm.local$get, ...bdgs,
          wasm.local$get, ...bdg_idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.i32$const, nil,
          wasm.call, ...nth.uleb128,
          wasm.call, ...comp_func_add_local.uleb128,
          wasm.local$get, ...env,
          wasm.call, ...free.uleb128,
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
    wasm.i32$const, 1,
    wasm.i32$const, nil,
    wasm.call, ...nth.uleb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code.uleb128,
    wasm.drop,
    wasm.local$get, ...env,
    wasm.call, ...free.uleb128
  ];
});

const free_local = funcs.build(
  [wasm.i32], [], {},
  function (local) {
    return [
      wasm.local$get, ...local,
      wasm.i32$const, 1,
      wasm.call, ...set_local_free_external.uleb128,
      wasm.i32$eqz,
      wasm.if, wasm.void,
        wasm.local$get, ...local,
        wasm.call, ...free.uleb128,
      wasm.end,
    ];
  }
);

// todo: move procedure for each to function call to reduce code size
const free_locals = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (func, env, reset) {
    const locals = this.local(wasm.i32),
          idx = this.local(wasm.i32),
          local = this.local(wasm.i32),
          cnt = this.local(wasm.i32);
    return [
      wasm.local$get, ...env,
      wasm.call, ...get_locals_to_free.uleb128,
      wasm.local$tee, ...locals,
      wasm.call, ...types.Array.fields.length.uleb128,
      wasm.local$set, ...cnt,
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...cnt,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...func,
          wasm.i32$const, ...sleb128i32(wasm.local$get),
          wasm.call, ...append_code.uleb128,
          wasm.local$get, ...locals,
          wasm.local$get, ...idx,
          wasm.call, ...array_get_i32.uleb128,
          wasm.local$tee, ...local,
          wasm.call, ...append_varuint32.uleb128,
          wasm.i32$const, ...sleb128i32(wasm.call),
          wasm.call, ...append_code.uleb128,
          wasm.i32$const, ...free_local.sleb128,
          wasm.call, ...append_varuint32.uleb128,
          wasm.drop,
          wasm.local$get, ...reset,
          wasm.if, wasm.void,
            wasm.local$get, ...func,
            wasm.i32$const, ...sleb128i32(wasm.i32$const),
            wasm.call, ...append_code.uleb128,
            wasm.i32$const, 0,
            wasm.call, ...append_varsint32.uleb128,
            wasm.i32$const, ...sleb128i32(wasm.local$set),
            wasm.call, ...append_code.uleb128,
            wasm.local$get, ...local,
            wasm.call, ...append_varuint32.uleb128,
            wasm.drop,
          wasm.end,
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

const off_check_local_free_local = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (local_idx, type, func, env) {
    const was_on = this.local(wasm.i32);
    return [
      wasm.local$get, ...type,
      wasm.i32$const, ...sleb128i32(wasm.i32),
      wasm.i32$eq,
      wasm.if, wasm.void,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.i32$const),
        wasm.call, ...append_code.uleb128,
        wasm.i32$const, 1,
        wasm.call, ...append_varsint32.uleb128,
        wasm.i32$const, ...sleb128i32(wasm.call),
        wasm.call, ...append_code.uleb128,
        wasm.i32$const, ...set_local_free_external.sleb128,
        wasm.call, ...append_varuint32.uleb128,
        wasm.i32$const, ...sleb128i32(wasm.local$set),
        wasm.call, ...append_code.uleb128,
        wasm.local$get, ...env,
        wasm.local$get, ...func,
        wasm.i32$const, 1,
        wasm.i32$const, ...sleb128i32(wasm.i32),
        wasm.call, ...inc_locals.uleb128,
        wasm.local$tee, ...was_on,
        wasm.call, ...append_varuint32.uleb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...was_on,
      wasm.local$get, ...local_idx,
      wasm.local$get, ...type
    ];
  }
);

// todo: avoid freeing return val?
// just set external to true before freeing other vals,
// then reset it
const off_check_local_free_return_val = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32], {},
  function (form, arr, func, env) {
    const was_on = this.local(wasm.i32),
          local_idx = this.local(wasm.i32),
          local_typ = this.local(wasm.i32);
    return [
      wasm.local$get, ...form,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...emit_local_val.uleb128,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...off_check_local_free_local.uleb128,
      wasm.local$set, ...local_typ,
      wasm.local$set, ...local_idx,
      wasm.local$set, ...was_on,
      // set idx 0 and 1 of locals_to_revert arr
      // (compare to off_check_local_free_params)
      wasm.local$get, ...arr,
      wasm.i32$const, 0,
      wasm.local$get, ...local_idx,
      wasm.call, ...array_set_i32.uleb128,
      wasm.i32$const, 1,
      wasm.local$get, ...was_on,
      wasm.call, ...array_set_i32.uleb128,
      wasm.drop,
      wasm.local$get, ...local_idx,
      wasm.local$get, ...local_typ,
    ];
  }
);

const off_check_local_free_params = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32], {},
  function (params, scope, len, do_free, func, env) {
    const arr = this.local(wasm.i32),
          idx = this.local(wasm.i32),
          param_idx = this.local(wasm.i32),
          was_on = this.local(wasm.i32);
    return [
      wasm.local$get, ...params,
      wasm.i32$const, ...sleb128i32(empty_seq),
      wasm.i32$eq,
      wasm.if, wasm.void,
        wasm.local$get, ...scope,
        wasm.i32$const, ...sleb128i32(empty_seq),
        wasm.i32$eq,
        wasm.if, wasm.void,
          wasm.local$get, ...len,
          wasm.call, ...array_by_length.uleb128,
          wasm.local$set, ...arr,
        wasm.else,
          wasm.local$get, ...scope,
          wasm.i32$const, ...sleb128i32(empty_seq),
          wasm.local$get, ...len,
          wasm.i32$const, 0,
          wasm.local$get, ...func,
          wasm.local$get, ...env,
          wasm.call, ...this.uleb128,
          wasm.local$set, ...len,
          wasm.local$set, ...arr,
        wasm.end,
      wasm.else,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.local$get),
        wasm.call, ...append_code.uleb128,
        wasm.local$get, ...env,
        wasm.local$get, ...params,
        wasm.call, ...first.uleb128,
        wasm.i32$const, nil,
        wasm.call, ...get.uleb128,
        wasm.call, ...types.Int.fields.value.uleb128,
        wasm.i32$wrap_i64,
        wasm.local$tee, ...param_idx,
        wasm.call, ...append_varuint32.uleb128,
        wasm.drop,
        wasm.local$get, ...param_idx,
// todo: check for type, skip num64
        wasm.i32$const, ...sleb128i32(wasm.i32),
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.call, ...off_check_local_free_local.uleb128,
        wasm.drop,
        wasm.drop,
        wasm.local$set, ...was_on,
        wasm.local$get, ...params,
        wasm.call, ...rest.uleb128,
        wasm.local$get, ...do_free,
        wasm.if, wasm.void,
          wasm.local$get, ...params,
          wasm.call, ...free.uleb128,
        wasm.end,
        wasm.local$get, ...scope,
        wasm.local$get, ...len,
        wasm.local$tee, ...idx,
        wasm.i32$const, 2,
        wasm.i32$add,
        wasm.i32$const, 1,
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.call, ...this.uleb128,
        wasm.local$set, ...len,
        wasm.local$tee, ...arr,
        wasm.local$get, ...idx,
        wasm.local$get, ...param_idx,
        wasm.call, ...array_set_i32.uleb128,
        wasm.local$get, ...idx,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.local$get, ...was_on,
        wasm.call, ...array_set_i32.uleb128,
        wasm.drop,
      wasm.end,
      wasm.local$get, ...arr,
      wasm.local$get, ...len,
    ];
  }
);

const revert_local_free = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (func, env, arr, len) {
    const idx = this.local(wasm.i32);
    return [
      wasm.loop, wasm.void,
        wasm.local$get, ...idx,
        wasm.local$get, ...len,
        wasm.i32$lt_u,
        wasm.if, wasm.void,
          wasm.local$get, ...func,
          wasm.i32$const, ...sleb128i32(wasm.local$get),
          wasm.call, ...append_code.uleb128,
          wasm.local$get, ...arr,
          wasm.local$get, ...idx,
          wasm.call, ...array_get_i32.uleb128,
          wasm.call, ...append_varuint32.uleb128,
          wasm.i32$const, ...sleb128i32(wasm.local$get),
          wasm.call, ...append_code.uleb128,
          wasm.local$get, ...arr,
          wasm.local$get, ...idx,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.call, ...array_get_i32.uleb128,
          wasm.call, ...append_varuint32.uleb128,
          wasm.i32$const, ...sleb128i32(wasm.call),
          wasm.call, ...append_code.uleb128,
          wasm.i32$const, ...set_local_free_external.sleb128,
          wasm.call, ...append_varuint32.uleb128,
          wasm.i32$const, ...sleb128i32(wasm.drop),
          wasm.call, ...append_code.uleb128,
          wasm.drop,
          wasm.local$get, ...idx,
          wasm.i32$const, 2,
          wasm.i32$add,
          wasm.local$set, ...idx,
          wasm.br, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...func
    ];
  }
);

// todo: check if return value may be unaltered parameter & inc-refs
// may need to be deferred to let?
def_special_form("fn", function (func, form, env) {
  const inner_env = this.local(wasm.i32),
        name = this.local(wasm.i32),
        result = this.local(wasm.i32),
        i32_count = this.local(wasm.i32),
        i64_count = this.local(wasm.i32),
        f64_count = this.local(wasm.i32),
        func_idx = this.local(wasm.i32),
        func_num = this.local(wasm.i32),
        tabl_idx = this.local(wasm.i32),
        type_idx = this.local(wasm.i32),
        locals_to_revert = this.local(wasm.i32),
        locals_to_revert_len = this.local(wasm.i32),
        return_local = this.local(wasm.i32),
        scope_local = this.local(wasm.i32),
        fn = this.local(wasm.i32);
  return [
    wasm.local$get, ...func,
    wasm.call, ...start_func.uleb128,
    wasm.local$tee, ...func_idx,
    wasm.local$get, ...form,
    wasm.call, ...first.uleb128,
    wasm.local$get, ...form,
    wasm.call, ...rest.uleb128,
    wasm.local$tee, ...form,
    wasm.call, ...first.uleb128,
    wasm.local$get, ...env,
    wasm.local$get, ...env,
    wasm.call, ...new_env.uleb128,
    wasm.call, ...comp_func_set_params.uleb128,
    wasm.local$set, ...f64_count,
    wasm.local$set, ...i64_count,
    wasm.local$set, ...i32_count,
    wasm.local$set, ...result,
    wasm.local$set, ...inner_env,
    wasm.local$set, ...scope_local,
// todo: move to comp_func_set_params
    wasm.i32$const, 2,
    wasm.i32$const, 0,
    wasm.local$get, ...func_idx,
    wasm.local$get, ...inner_env,
    wasm.call, ...off_check_local_free_params.uleb128,
    wasm.local$set, ...locals_to_revert_len,
    wasm.local$set, ...locals_to_revert,
    wasm.local$get, ...func_idx,
    wasm.call, ...get_func_num.uleb128,
    wasm.local$tee, ...func_num,
    wasm.call, ...add_to_func_table.uleb128,
    wasm.local$set, ...tabl_idx,
    wasm.local$get, ...i32_count,
    wasm.local$get, ...i64_count,
    wasm.local$get, ...f64_count,
    wasm.local$get, ...result,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.i32$eq,
    wasm.local$get, ...result,
    wasm.i32$const, ...sleb128i32(wasm.i64),
    wasm.i32$eq,
    wasm.local$get, ...result,
    wasm.i32$const, ...sleb128i32(wasm.f64),
    wasm.i32$eq,
    wasm.call, ...get_type_idx.uleb128,
    wasm.local$set, ...type_idx,
    // wasm.local$get, ...xpt,
    // wasm.if, wasm.void,
    //   wasm.local$get, ...func_idx,
    //   wasm.local$get, ...name,
    //   wasm.call, ...types.Symbol.fields.name.uleb128,
    //   wasm.call, ...store_string.uleb128,
    //   wasm.call, ...set_export.uleb128,
    //   wasm.drop,
    // wasm.end,
    wasm.local$get, ...form,
    wasm.call, ...rest.uleb128,
    wasm.local$get, ...form,
    wasm.call, ...free.uleb128,
    wasm.local$tee, ...form,
    wasm.call, ...first.uleb128,
    wasm.local$get, ...locals_to_revert,
    wasm.local$get, ...func_idx,
    wasm.local$get, ...inner_env,
    wasm.call, ...off_check_local_free_return_val.uleb128,
// todo: this should be return type of func
    wasm.drop,
    wasm.local$set, ...return_local,
    wasm.local$get, ...func_idx,
    wasm.local$get, ...inner_env,
    wasm.i32$const, 0,
    wasm.call, ...free_locals.uleb128,
    wasm.local$get, ...inner_env,
    wasm.local$get, ...locals_to_revert,
    wasm.local$get, ...locals_to_revert_len,
    wasm.call, ...revert_local_free.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.local$get),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...return_local,
    wasm.call, ...append_varuint32.uleb128,
    wasm.call, ...end_func.uleb128,
    wasm.drop,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...func_num,
    wasm.call, ...append_varsint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...tabl_idx,
    wasm.call, ...append_varsint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...type_idx,
    wasm.call, ...append_varsint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.call, ...append_varsint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...i32_count,
    wasm.call, ...append_varsint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...i64_count,
    wasm.call, ...append_varsint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.i32$const),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...f64_count,
    wasm.call, ...append_varsint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.local$get),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...scope_local,
    wasm.call, ...append_varuint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.call),
    wasm.call, ...append_code.uleb128,
    wasm.i32$const, ...inc_refs.sleb128,
    wasm.call, ...append_varuint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.call),
    wasm.call, ...append_code.uleb128,
// todo: change to Function2
    wasm.i32$const, ...sleb128i32(types.Function.constr.func_idx),
    wasm.call, ...append_varuint32.uleb128,
    wasm.local$get, ...env,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.call, ...stage_val_to_free.uleb128,
    wasm.drop,
    wasm.local$get, ...form,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...inner_env,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...locals_to_revert,
    wasm.call, ...free.uleb128,
    wasm.i32$const, 2
  ];
});

const inc_loop_depth = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (env) {
    const depth = this.local(wasm.i32);
    return [
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("loop-depth")),
      wasm.i32$const, nil,
      wasm.call, ...get.uleb128,
      wasm.local$tee, ...depth,
      wasm.if, wasm.i32,
        wasm.local$get, ...env,
        wasm.i32$const, ...sleb128i32(make_keyword("loop-depth")),
        wasm.local$get, ...depth,
        wasm.call, ...types.Int.fields.value.uleb128,
        wasm.i64$const, 1,
        wasm.i64$add,
        wasm.call, ...types.Int.constr.uleb128,
        wasm.call, ...assoc.uleb128,
      wasm.else,
        wasm.local$get, ...env,
        wasm.i32$const, ...sleb128i32(make_keyword("loop-depth")),
        wasm.i64$const, 0,
        wasm.call, ...types.Int.constr.uleb128,
        wasm.call, ...assoc.uleb128,
      wasm.end
    ];
  }
);

// todo: needs full review
// todo: prepare for syntax-list
def_special_form("loop", function (func, forms, env) {
  const to_revert_arr = this.local(wasm.i32),
        to_revert_len = this.local(wasm.i32),
        return_type = this.local(wasm.i32),
        return_local = this.local(wasm.i32);
  return [
    wasm.local$get, ...env,
    wasm.i32$const, ...sleb128i32(make_keyword("locals-to-free")),
    wasm.i32$const, 0,
    wasm.call, ...array_by_length.uleb128,
// todo: look at new_env (keep refs 0)
    wasm.call, ...inc_refs.uleb128,
    wasm.i32$const, 0,
    wasm.call, ...types.Atom.constr.uleb128,
    wasm.call, ...assoc.uleb128,
    wasm.local$tee, ...env,
    wasm.call, ...inc_loop_depth.uleb128,
    wasm.local$get, ...env,
    wasm.call, ...free.uleb128,
    wasm.local$set, ...env,
    wasm.local$get, ...forms,
    wasm.call, ...first.uleb128,
    wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.i32$const, 2,
    wasm.i32$const, 0,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
// todo: is this working?
    wasm.call, ...off_check_local_free_params.uleb128,
    wasm.local$set, ...to_revert_len,
    wasm.local$set, ...to_revert_arr,
    wasm.local$get, ...forms,
    wasm.i32$const, 1,
    wasm.i32$const, nil,
    wasm.call, ...nth.uleb128,
    //wasm.local$get, ...forms,
    //wasm.call, ...free.uleb128,
    wasm.local$get, ...to_revert_arr,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.loop),
    wasm.call, ...append_code.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...env,
    wasm.call, ...off_check_local_free_return_val.uleb128,
    wasm.local$set, ...return_type,
    wasm.local$set, ...return_local,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.i32$const, 0,
    wasm.call, ...free_locals.uleb128,
    wasm.local$get, ...env,
    wasm.local$get, ...to_revert_arr,
    wasm.local$get, ...to_revert_len,
    wasm.call, ...revert_local_free.uleb128,
    //wasm.i32$const, ...sleb128i32(wasm.local$get),
    //wasm.call, ...append_code.uleb128,
    //wasm.local$get, ...return_local,
    //wasm.call, ...append_varuint32.uleb128,
    //wasm.i32$const, ...sleb128i32(wasm.local$get),
    //wasm.call, ...append_code.uleb128,
    //wasm.local$get, ...return_was_on,
    //wasm.call, ...append_varuint32.uleb128,
    //wasm.i32$const, ...sleb128i32(wasm.call),
    //wasm.call, ...append_code.uleb128,
    //wasm.i32$const, ...set_local_free_external.sleb128,
    //wasm.call, ...append_varuint32.uleb128,
    //wasm.i32$const, ...sleb128i32(wasm.drop),
    //wasm.call, ...append_code.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.local$get),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...return_local,
    wasm.call, ...append_varuint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.end),
    wasm.call, ...append_code.uleb128,
    wasm.drop,
    //wasm.local$get, ...forms,
    //wasm.call, ...free.uleb128,
    wasm.local$get, ...env,
// todo: recursive?
    wasm.call, ...free.uleb128,
    wasm.local$get, ...return_type
  ];
});

def_special_form("if", function (func, forms, env) {
  const result1 = this.local(wasm.i32),
        result2 = this.local(wasm.i32);
  return [
    wasm.local$get, ...forms,
    wasm.call, ...first.uleb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...inc_loop_depth.uleb128,
    wasm.local$tee, ...env,
    wasm.call, ...emit_code.uleb128,
    wasm.drop,
    wasm.drop,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.if),
    wasm.call, ...append_code.uleb128,
// todo: allow i64/f64 return
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.call, ...append_code.uleb128,
    wasm.drop,
    wasm.local$get, ...forms,
    wasm.call, ...rest.uleb128,
    wasm.local$tee, ...forms,
    wasm.call, ...first.uleb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code.uleb128,
    wasm.drop,
    wasm.local$set, ...result1,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.else),
    wasm.call, ...append_code.uleb128,
    wasm.drop,
    wasm.local$get, ...forms,
    wasm.call, ...rest.uleb128,
    wasm.local$get, ...forms,
    wasm.call, ...free.uleb128,
    wasm.local$tee, ...forms,
    wasm.call, ...first.uleb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code.uleb128,
    wasm.drop,
    wasm.local$tee, ...result2,
    wasm.local$get, ...result1,
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.i32$const, 1,
    wasm.else,
      wasm.local$get, ...result2,
      // conforms to any type
      wasm.i32$const, 1,
      wasm.i32$eq,
      wasm.if, wasm.i32,
        wasm.local$get, ...result1,
        wasm.local$tee, ...result2,
      wasm.else,
        wasm.local$get, ...result1,
        // conforms to any type
        wasm.i32$const, 1,
        wasm.i32$eq,
        wasm.if, wasm.i32,
          wasm.i32$const, 1,
        wasm.else,
          wasm.local$get, ...result2,
          // wasm.i32
          wasm.i32$const, 2,
          wasm.i32$eq,
          wasm.if, wasm.i32,
            wasm.local$get, ...result1,
            wasm.i32$const, ...sleb128i32(wasm.i32),
            wasm.i32$eq,
            wasm.if, wasm.i32,
              wasm.local$get, ...result1,
              wasm.local$tee, ...result2,
            wasm.else,
              wasm.i32$const, 0,
            wasm.end,
          wasm.else,
            wasm.local$get, ...result2,
            wasm.i32$const, ...sleb128i32(wasm.i32),
            wasm.i32$eq,
            wasm.if, wasm.i32,
              wasm.local$get, ...result1,
              wasm.i32$const, 2,
              wasm.i32$eq,
              wasm.if, wasm.i32,
                wasm.i32$const, 1,
              wasm.else,
                wasm.i32$const, 0,
              wasm.end,
            wasm.else,
              wasm.i32$const, 0,
            wasm.end,
          wasm.end,
        wasm.end,
      wasm.end,
    wasm.end,
    wasm.i32$eqz,
    wasm.if, wasm.void,
      wasm.i32$const, 0,
      wasm.i32$const, ...sleb128i32(cached_string("if branch types do not match")),
      wasm.call, ...types.Exception.constr.uleb128,
      wasm.throw, 0,
    wasm.end,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.end),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...env,
    wasm.local$get, ...result2,
// todo: why need this if done in branches?
    wasm.call, ...stage_val_to_free.uleb128,
    wasm.drop,
    wasm.local$get, ...forms,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...env,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...result2,
  ];
});

// def_special_form("try", function (func) {
//   const fn = func.param(wasm.i32),
//         forms = func.param(wasm.i32),
//         env = func.param(wasm.i32);
//   func.add_result(wasm.i32);
//   func.append_code(
//     wasm.local$get, ...forms,
//     wasm.call, ...first.uleb128,
//     wasm.local$get, ...func,
//     wasm.i32$const, ...sleb128i32(wasm.throw),
//     
//     wasm.local$get, ...env,
//     wasm.call, ...emit_code.uleb128,
//   );
// });

def_special_form("throw", function (func, forms, env) {
  return [
    wasm.local$get, ...forms,
    wasm.call, ...first.uleb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code.uleb128,
    wasm.drop,
    wasm.drop,
    wasm.local$get, ...forms,
    wasm.call, ...rest.uleb128,
    wasm.local$tee, ...forms,
    wasm.call, ...first.uleb128,
    wasm.local$get, ...forms,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code.uleb128,
    wasm.drop,
    wasm.drop,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.call),
    wasm.call, ...append_code.uleb128,
    wasm.i32$const, ...sleb128i32(types.Exception.constr.func_idx),
    wasm.call, ...append_varuint32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.throw),
    wasm.call, ...append_code.uleb128,
    wasm.i32$const, 0,
    wasm.call, ...append_varuint32.uleb128,
    wasm.drop,
    // can conform to any type
    wasm.i32$const, 1
  ];
});

// todo: review this, make safe for syntax list
// allow use with comp data? - free old value
def_special_form("set-local", function (func, forms, env) {
  const loc_num = this.local(wasm.i32),
        val = this.local(wasm.i32),
        result = this.local(wasm.i32);
  return [
    wasm.local$get, ...env,
    wasm.call, ...get_locals_array.uleb128,
    wasm.local$get, ...env,
    wasm.local$get, ...forms,
    wasm.call, ...first.uleb128,
    wasm.i32$const, nil,
    wasm.call, ...get.uleb128,
    wasm.call, ...types.Int.fields.value.uleb128,
    wasm.i32$wrap_i64,
    wasm.local$tee, ...loc_num,
    wasm.call, ...array_get_i32.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.i32$eq,
    wasm.local$get, ...forms,
    wasm.i32$const, 1,
    wasm.i32$const, nil,
    wasm.call, ...nth.uleb128,
    wasm.local$tee, ...val,
    wasm.local$get, ...env,
    wasm.call, ...is_num64.uleb128,
    wasm.local$tee, ...result,
    wasm.i32$eqz,
    wasm.i32$or,
    wasm.if, wasm.i32,
      wasm.i32$const, 0,
      wasm.i32$const, ...sleb128i32(cached_string("set-local can only be used for i64 or f64")),
      wasm.call, ...types.Exception.constr.uleb128,
      wasm.throw, 0,
    wasm.else,
      wasm.local$get, ...val,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...emit_code.uleb128,
      wasm.drop,
      wasm.drop,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.local$tee),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...loc_num,
      wasm.call, ...append_varuint32.uleb128,
    wasm.end,
    wasm.drop,
    wasm.local$get, ...result,
    // wasm.local$get, ...forms,
    // wasm.call, ...free.uleb128
  ];
});

def_special_form("recur", function (func, forms, env) {
  return [
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.i32$const, 1,
// todo: review this, make sure locals are being freed properly
    wasm.call, ...free_locals.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.br),
    wasm.call, ...append_code.uleb128,
    wasm.local$get, ...env,
    wasm.i32$const, ...sleb128i32(make_keyword("loop-depth")),
    wasm.i32$const, nil,
    wasm.call, ...get.uleb128,
    wasm.call, ...types.Int.fields.value.uleb128,
    wasm.i32$wrap_i64,
    wasm.call, ...append_varuint32.uleb128,
    wasm.drop,
    wasm.i32$const, 1,
    //wasm.local$get, ...forms,
    //wasm.call, ...free.uleb128
  ];
});

// def_special_form("Float$value", function (func, args, env) {
//   const num = this.local(wasm.i32),
//         val = this.local(wasm.i64),
//         cnt = this.local(wasm.i32);
//   return [
//     wasm.local$get, ...args,
//     wasm.call, ...first.uleb128,
//     wasm.local$tee, ...num,
//     wasm.call, ...types.Float.pred.uleb128,
//     wasm.if, wasm.i32,
//       wasm.local$get, ...func,
//       wasm.i32$const, ...sleb128i32(wasm.f64$const),
//       wasm.call, ...append_code.uleb128,
//       wasm.drop,
//       wasm.local$get, ...num,
//       wasm.call, ...types.Float.fields.value.uleb128,
//       wasm.i64$reinterpret_f64,
//       wasm.local$set, ...val,
//       // wasm.local$get, ...num,
//       // wasm.call, ...free.uleb128,
//       wasm.local$get, ...args,
//       wasm.call, ...free.uleb128,
//       wasm.i32$const, 8,
//       wasm.local$set, ...cnt,
//       wasm.loop, wasm.void,
//         wasm.local$get, ...func,
//         wasm.i64$const, ...sleb128i64(0b11111111),
//         wasm.local$get, ...val,
//         wasm.i64$and,
//         wasm.i32$wrap_i64,
//         wasm.call, ...append_code.uleb128,
//         wasm.drop,
//         wasm.local$get, ...val,
//         wasm.i64$const, 8,
//         wasm.i64$shr_u,
//         wasm.local$set, ...val,
//         wasm.local$get, ...cnt,
//         wasm.i32$const, 1,
//         wasm.i32$sub,
//         wasm.local$tee, ...cnt,
//         wasm.br_if, 0,
//       wasm.end,
//       wasm.i32$const, ...sleb128i32(wasm.f64),
//     wasm.else,
//       wasm.i32$const, 0,
//     wasm.end
//   ];
// });
// 
// def_special_form("Int$value", function (func, args, env) {
//   const num = this.local(wasm.i32);
//   return [
//     wasm.local$get, ...args,
//     wasm.call, ...first.uleb128,
//     wasm.local$tee, ...num,
//     wasm.call, ...types.Int.pred.uleb128,
//     wasm.if, wasm.i32,
//       wasm.local$get, ...func,
//       wasm.i32$const, ...sleb128i32(wasm.i64$const),
//       wasm.call, ...append_code.uleb128,
//       wasm.local$get, ...num,
//       wasm.call, ...types.Int.fields.value.uleb128,
//       wasm.call, ...append_varsint64.uleb128,
//       wasm.drop,
//       wasm.i32$const, ...sleb128i32(wasm.i64),
//       // wasm.local$get, ...num,
//       // wasm.call, ...free.uleb128,
//       wasm.local$get, ...args,
//       wasm.call, ...free.uleb128,
//     wasm.else,
//       wasm.i32$const, 0,
//     wasm.end
//   ];
// });

def_special_form("do", function (func, forms, env) {
  const result = this.local(wasm.i32),
        idx = this.local(wasm.i32);
  return [
    wasm.local$get, ...env,
    wasm.call, ...inc_loop_depth.uleb128,
    wasm.local$set, ...env,
    wasm.local$get, ...func,
    wasm.i32$const, ...sleb128i32(wasm.block),
    wasm.call, ...append_code.uleb128,
    wasm.i32$const, ...sleb128i32(wasm.i32),
    wasm.call, ...append_code.uleb128,
    wasm.loop, wasm.void,
      wasm.local$get, ...forms,
      wasm.call, ...first.uleb128,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...emit_code.uleb128,
      wasm.drop,
      wasm.local$set, ...result,
      wasm.local$get, ...forms,
      wasm.call, ...rest.uleb128,
      wasm.local$get, ...idx,
      wasm.if, wasm.void,
        wasm.local$get, ...forms,
        wasm.call, ...free.uleb128,
      wasm.end,
      wasm.local$set, ...forms,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$set, ...idx,
      wasm.local$get, ...forms,
      wasm.i32$const, ...sleb128i32(empty_seq),
      wasm.i32$ne,
      wasm.if, wasm.void,
        wasm.local$get, ...func,
        wasm.i32$const, ...sleb128i32(wasm.drop),
        wasm.call, ...append_code.uleb128,
        wasm.br, 1,
      wasm.end,
    wasm.end,
    wasm.i32$const, ...sleb128i32(wasm.end),
    wasm.call, ...append_code.uleb128,
    wasm.drop,
    wasm.local$get, ...env,
    wasm.call, ...free.uleb128,
    wasm.local$get, ...result
  ];
});

def_special_form("quote", function (func, forms, env) {
  return [
    wasm.local$get, ...forms,
    wasm.call, ...first.uleb128,
    wasm.local$get, ...func,
    wasm.local$get, ...env,
    wasm.call, ...emit_code_default.uleb128,
    wasm.drop,
  ];
});

const emit_code_special_form = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (head, args, func, env) {
    const xpt = this.local(wasm.i32),
          hdl = this.local(wasm.i32);
    return [
      wasm.local$get, ...head,
      wasm.call, ...types.Symbol.pred.uleb128,
      wasm.if, wasm.i32,
        wasm.i32$const, ...sleb128i32(special_forms),
        wasm.local$get, ...head,
        wasm.i32$const, nil,
        wasm.call, ...get.uleb128,
        wasm.local$tee, ...hdl,
        wasm.if, wasm.i32,
          wasm.local$get, ...func,
          wasm.local$get, ...args,
          wasm.local$get, ...env,
          wasm.local$get, ...hdl,
          wasm.call, ...func_tbl_idx.uleb128,
          wasm.call_indirect,
          ...sleb128i32(get_type_idx(3, 0, 0, 1, 0, 0)), 0,
        wasm.else,
          wasm.i32$const, 0,
        wasm.end,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end,
    ];
  }
);

const is_num64_bool_op = funcs.build(
  [wasm.i32], [wasm.i32], {},
  function (op) {
    return [
      wasm.local$get, ...op,
      wasm.i32$const, ...sleb128i32(cached_string("eq")),
      wasm.call, ...eq.uleb128,
      wasm.local$get, ...op,
      wasm.i32$const, ...sleb128i32(cached_string("eqz")),
      wasm.call, ...eq.uleb128,
      wasm.i32$or,
      wasm.local$get, ...op,
      wasm.i32$const, ...sleb128i32(cached_string("lt_u")),
      wasm.call, ...eq.uleb128,
      wasm.i32$or,
      wasm.local$get, ...op,
      wasm.i32$const, ...sleb128i32(cached_string("gt_u")),
      wasm.call, ...eq.uleb128,
      wasm.i32$or,
      wasm.local$get, ...op,
      wasm.i32$const, ...sleb128i32(cached_string("ge_u")),
      wasm.call, ...eq.uleb128,
      wasm.i32$or,
    ];
  }
);

// todo: if arg is func with num64 return, don't add conversion to Int
const emit_code_num64 = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32], [wasm.i32], {},
  function (head, args, func, env) {
    const ns = this.local(wasm.i32),
          nm = this.local(wasm.i32),
          is_i64 = this.local(wasm.i32),
          idx = this.local(wasm.i32),
          op = this.local(wasm.i32),
          inner_env = this.local(wasm.i32);
    return [
      wasm.local$get, ...head,
      wasm.call, ...types.Symbol.pred.uleb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...head,
        wasm.call, ...types.Symbol.fields.namespace.uleb128,
        wasm.local$tee, ...ns,
        wasm.i32$const, ...sleb128i32(cached_string("i64")),
        wasm.call, ...eq.uleb128,
        wasm.local$tee, ...is_i64,
        wasm.local$get, ...ns,
        wasm.i32$const, ...sleb128i32(cached_string("f64")),
        wasm.call, ...eq.uleb128,
        wasm.i32$or,
        wasm.if, wasm.i32,
          wasm.local$get, ...env,
          wasm.i32$const, ...sleb128i32(make_keyword("is-num64")),
          wasm.local$get, ...is_i64,
          wasm.if, wasm.i32,
            wasm.i32$const, ...sleb128i32(comp_true),
          wasm.else,
            wasm.i32$const, ...sleb128i32(comp_false),
          wasm.end,
          wasm.call, ...assoc.uleb128,
          wasm.local$set, ...inner_env,
          wasm.loop, wasm.void,
            wasm.local$get, ...args,
            wasm.i32$const, ...sleb128i32(empty_seq),
            wasm.i32$ne,
            wasm.if, wasm.void,
              wasm.local$get, ...args,
              wasm.call, ...first.uleb128,
              wasm.local$get, ...func,
              wasm.local$get, ...inner_env,
              wasm.call, ...emit_code.uleb128,
              wasm.drop,
              wasm.drop,
              wasm.local$get, ...args,
              wasm.call, ...rest.uleb128,
              wasm.local$get, ...idx,
              wasm.if, wasm.void,
                wasm.local$get, ...args,
                wasm.call, ...free.uleb128,
              wasm.end,
              wasm.local$set, ...args,
              wasm.local$get, ...idx,
              wasm.i32$const, 1,
              wasm.i32$add,
              wasm.local$set, ...idx,
              wasm.br, 1,
            wasm.end,
          wasm.end,
          wasm.local$get, ...inner_env,
          wasm.local$get, ...env,
          wasm.call, ...free_if_not_eq.uleb128,
          wasm.local$get, ...func,
          wasm.local$get, ...ns,
// todo: comp_string_to_js method for FileSlice/String
          wasm.call, ...force_to_string.uleb128,
          wasm.local$get, ...head,
          wasm.call, ...types.Symbol.fields.name.uleb128,
          wasm.local$tee, ...nm,
// todo: comp_string_to_js method for FileSlice/String
          wasm.call, ...force_to_string.uleb128,
          wasm.call, ...get_op_code.uleb128,
          wasm.call, ...append_code.uleb128,
          wasm.drop,
          wasm.local$get, ...env,
          wasm.i32$const, ...sleb128i32(make_keyword("is-num64")),
          wasm.i32$const, nil,
          wasm.call, ...get.uleb128,
          wasm.if, wasm.i32,
            wasm.local$get, ...is_i64,
            wasm.if, wasm.i32,
              wasm.i32$const, ...sleb128i32(wasm.i64),
            wasm.else,
              wasm.i32$const, ...sleb128i32(wasm.f64),
            wasm.end,
          wasm.else,
            wasm.local$get, ...nm,
            wasm.call, ...is_num64_bool_op.uleb128,
            wasm.i32$eqz,
            wasm.if, wasm.void,
              wasm.local$get, ...func,
              wasm.i32$const, ...sleb128i32(wasm.call),
              wasm.call, ...append_code.uleb128,
              wasm.drop,
              wasm.local$get, ...is_i64,
              wasm.if, wasm.void,
                wasm.local$get, ...func,
                wasm.i32$const, ...sleb128i32(types.Int.constr.func_idx),
                wasm.call, ...append_varuint32.uleb128,
                wasm.drop,
              wasm.else,
                wasm.local$get, ...func,
                wasm.i32$const, ...sleb128i32(types.Float.constr.func_idx),
                wasm.call, ...append_varuint32.uleb128,
                wasm.drop,
              wasm.end,
            wasm.end,
            wasm.i32$const, 2,
          wasm.end,
        wasm.else,
          wasm.i32$const, 0,
        wasm.end,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end,
    ];
  }
);

function emit_list_to_array (list, each, func, env) {
  const idx = this.local(wasm.i32);
  return [
    wasm.loop, wasm.void,
      wasm.local$get, ...list,
      wasm.i32$const, ...sleb128i32(empty_list),
      wasm.i32$ne,
      wasm.if, wasm.void,
        wasm.local$get, ...list,
        wasm.call, ...first.uleb128,
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.call, ...emit_form.uleb128,
        wasm.drop,
        wasm.drop,
        wasm.local$get, ...list,
        wasm.call, ...rest.uleb128,
        wasm.local$get, ...idx,
        wasm.if, wasm.void,
          wasm.local$get, ...list,
          wasm.call, ...free.uleb128,
        wasm.end,
        wasm.local$set, ...list,
        wasm.local$get, ...idx,
        wasm.i32$const, 1,
        wasm.i32$add,
        wasm.local$set, ...idx,
        wasm.br, 1,
      wasm.end,
    wasm.end,
    wasm.i32.local$get, ...func,
  ];
}

// todo: emit number directly in wasm math form?
const emit_js_func_call = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32], {},
  function (head, args, func, env) {
    const idx = this.local(wasm.i32);
    return [
      wasm.local$get, ...head,
      wasm.call, ...types.Symbol.pred.uleb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...head,
        wasm.call, ...types.Symbol.fields.namespace.uleb128,
        wasm.i32$const, ...sleb128i32(cached_string("js")),
        wasm.call, ...eq.uleb128,
        wasm.if, wasm.i32,
          wasm.local$get, ...func,
          wasm.i32$const, ...sleb128i32(wasm.i32$const),
          wasm.call, ...append_code.uleb128,
          wasm.local$get, ...head,
// todo: get js function at compile time
          wasm.call, ...types.Symbol.fields.name.uleb128,
// todo: comp_string_to_js method for FileSlice/String
          wasm.call, ...force_to_string.uleb128,
// todo: stage_val_to_free?
          wasm.call, ...store_string.uleb128,
          wasm.call, ...append_varsint32.uleb128,
          wasm.loop, wasm.void,
            wasm.local$get, ...args,
            wasm.i32$const, ...sleb128i32(empty_seq),
            wasm.i32$ne,
            wasm.if, wasm.void,
              wasm.local$get, ...args,
              wasm.call, ...first.uleb128,
              wasm.local$get, ...func,
              wasm.local$get, ...env,
              wasm.call, ...emit_code.uleb128,
              wasm.drop,
              wasm.drop,
              wasm.local$get, ...func,
              wasm.i32$const, ...sleb128i32(wasm.call),
              wasm.call, ...append_code.uleb128,
              wasm.i32$const, ...to_js.sleb128,
              wasm.call, ...append_varuint32.uleb128,
              wasm.local$get, ...env,
              wasm.i32$const, ...sleb128i32(wasm.i32),
              wasm.call, ...stage_val_to_free.uleb128,
              wasm.drop,
              wasm.local$get, ...args,
              wasm.call, ...rest.uleb128,
              wasm.local$get, ...idx,
              wasm.if, wasm.void,
                wasm.local$get, ...args,
                wasm.call, ...free.uleb128,
                wasm.local$get, ...func,
                wasm.i32$const, ...sleb128i32(wasm.drop),
                wasm.call, ...append_code.uleb128,
                wasm.drop,
              wasm.else,
                wasm.local$get, ...func,
                wasm.i32$const, ...sleb128i32(wasm.call),
                wasm.call, ...append_code.uleb128,
                wasm.i32$const, ...sleb128i32(types.Object.fields.address.func_idx),
                wasm.call, ...append_varuint32.uleb128,
                wasm.drop,
              wasm.end,
              wasm.local$set, ...args,
              wasm.local$get, ...idx,
              wasm.i32$const, 1,
              wasm.i32$add,
              wasm.local$set, ...idx,
              wasm.br, 1,
            wasm.end,
          wasm.end,
          wasm.i32$const, ...sleb128i32(wasm.i32$const),
          wasm.call, ...append_code.uleb128,
          wasm.local$get, ...idx,
          wasm.call, ...append_varsint32.uleb128,
          wasm.i32$const, ...sleb128i32(wasm.call),
          wasm.call, ...append_code.uleb128,
          wasm.i32$const, ...js_call.sleb128,
          wasm.call, ...append_varuint32.uleb128,
          wasm.local$get, ...env,
          wasm.i32$const, ...sleb128i32(wasm.i32),
          wasm.call, ...stage_val_to_free.uleb128,
          wasm.drop,
          wasm.i32$const, ...sleb128i32(wasm.i32),
        wasm.else,
          wasm.i32$const, 0,
        wasm.end,
      wasm.else,
        wasm.i32$const, 0,
      wasm.end
    ];
  }
);

emit_code.implement(types.Int, function (num, func, env) {
  const is_i64 = this.local(wasm.i32);
  return [
    wasm.local$get, ...env,
    wasm.i32$const, ...sleb128i32(make_keyword("is-num64")),
    wasm.i32$const, nil,
    wasm.call, ...get.uleb128,
    wasm.local$tee, ...is_i64,
// todo: exception if = comp_false (is_f64)
    wasm.i32$const, ...sleb128i32(comp_true),
    wasm.i32$eq,
    wasm.if, wasm.i32,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.i64$const),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...num,
      wasm.call, ...types.Int.fields.value.uleb128,
      wasm.call, ...append_varsint64.uleb128,
      wasm.drop,
      wasm.i32$const, ...sleb128i32(wasm.i64),
    wasm.else,
      wasm.local$get, ...num,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...emit_code_default.uleb128,
      wasm.drop,
    wasm.end,
    wasm.i32$const, nil
  ];
});

emit_code.implement(types.Seq, function (list, func, env) {
  const list_head = this.local(wasm.i32),
        args_list = this.local(wasm.i32),
        inner_env = this.local(wasm.i32),
        is_num64 = this.local(wasm.i32),
        result = this.local(wasm.i32);
  return [
    wasm.local$get, ...list,
    wasm.i32$const, ...sleb128i32(empty_seq),
    wasm.i32$ne,
    wasm.if, wasm.void,
      wasm.local$get, ...list,
      wasm.call, ...first.uleb128,
      wasm.local$tee, ...list_head,
      wasm.local$get, ...list,
      wasm.call, ...rest.uleb128,
      wasm.local$tee, ...args_list,
      wasm.local$get, ...func,
      wasm.local$get, ...env,
      wasm.call, ...emit_code_num64.uleb128,
      wasm.local$tee, ...result,
      wasm.i32$eqz,
      wasm.if, wasm.void,
        wasm.local$get, ...list_head,
        wasm.local$get, ...args_list,
        wasm.local$get, ...func,
        wasm.local$get, ...env,
        wasm.i32$const, ...sleb128i32(make_keyword("is-num64")),
        wasm.i32$const, nil,
        wasm.call, ...assoc.uleb128,
        wasm.local$tee, ...inner_env,
        wasm.call, ...emit_js_func_call.uleb128,
        wasm.local$tee, ...result,
        wasm.i32$eqz,
        wasm.if, wasm.void,
          wasm.local$get, ...list_head,
          wasm.local$get, ...args_list,
          wasm.local$get, ...func,
          wasm.local$get, ...inner_env,
          wasm.call, ...emit_code_special_form.uleb128,
          wasm.local$tee, ...result,
          wasm.i32$eqz,
          wasm.if, wasm.void,
            wasm.local$get, ...func,
            wasm.local$get, ...inner_env,
            wasm.local$get, ...list_head,
            wasm.local$get, ...args_list,
            wasm.i32$const, 0,
            wasm.call, ...emit_func_call.uleb128,
            wasm.local$set, ...result,
          wasm.end,
        wasm.end,
        wasm.local$get, ...env,
        wasm.i32$const, ...sleb128i32(make_keyword("is-num64")),
        wasm.i32$const, nil,
        wasm.call, ...get.uleb128,
        wasm.local$tee, ...is_num64,
        wasm.i32$const, ...sleb128i32(comp_true),
        wasm.i32$eq,
        wasm.if, wasm.void,
          wasm.local$get, ...func,
          wasm.i32$const, ...sleb128i32(wasm.call),
          wasm.call, ...append_code.uleb128,
          wasm.i32$const, ...sleb128i32(types.Int.fields.value.func_idx),
          wasm.call, ...append_varuint32.uleb128,
          wasm.drop,
        wasm.end,
      wasm.end,
      wasm.local$get, ...args_list,
      wasm.call, ...free.uleb128,
    wasm.else,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.i32$const),
      wasm.call, ...append_code.uleb128,
      wasm.i32$const, ...sleb128i32(empty_seq),
      wasm.call, ...append_varsint32.uleb128,
      wasm.drop,
      // constant i32 val (not to be freed)
      wasm.i32$const, 2,
      wasm.local$set, ...result,
    wasm.end,
    wasm.local$get, ...result,
    wasm.i32$const, nil
  ];
});

/*-----------*\
|             |
| expand-form |
|             |
\*-----------*/

const expand_form = new_method(2, 0, 0, 1, 0, 0,
  { comp: "expand-form" }, (form, env) => [
    wasm.local$get, ...form,
  ]
);

/*------------*\
|              |
| compile-form |
|              |
\*------------*/

// todo: only return value if requested
const compile_form = funcs.build(
  [wasm.i32], [], {},
  function (form) {
    const out = this.local(wasm.i32),
          func = this.local(wasm.i32),
          new_form = this.local(wasm.i32),
          env = this.local(wasm.i32),
          a = this.local(wasm.i32);
    return [
//wasm.i32$const, ...sleb128i32(next_addr),
//wasm.i32$load, 2, 0,
//wasm.local$set, ...a,
      wasm.local$get, ...form,
      wasm.i32$const, ...sleb128i32(empty_hash_map),
      wasm.call, ...expand_form.uleb128,

//wasm.local$get, ...form,
//wasm.i32$const, 0,
//wasm.i32$const, nil,
//wasm.call, ...nth.uleb128,
//wasm.call, ...read_refs.uleb128,
//wasm.call, ...print_i32.uleb128,

      wasm.local$tee, ...new_form,
	    //wasm.local$get, ...new_form,
            //wasm.local$get, ...form,
	    //wasm.i32$ne,
	    //wasm.if, wasm.void,
            //wasm.local$get, ...form,
	    //wasm.call, ...print_coll_refs.uleb128,
	    //wasm.drop,
	    //wasm.end,
      //wasm.call, ...free.uleb128,
      wasm.call, ...start_func.uleb128,
      wasm.local$tee, ...func,
      // wasm.i32$const, ...sleb128i32(wasm.i32$const),
      // wasm.call, ...append_code.uleb128,
      // wasm.i32$const, 4,
      // wasm.call, ...alloc.uleb128,
      // wasm.local$tee, ...out,
      // wasm.call, ...append_varsint32.uleb128,
      wasm.i32$const, nil,
      wasm.call, ...new_env.uleb128,
      wasm.local$tee, ...env,
      wasm.call, ...emit_code.uleb128,
      wasm.drop,
      wasm.drop,
      wasm.local$get, ...func,
      wasm.i32$const, ...sleb128i32(wasm.drop),
      wasm.call, ...append_code.uleb128,
      wasm.local$get, ...env,
      wasm.i32$const, 0,
      wasm.call, ...free_locals.uleb128,
      // wasm.i32$const, ...sleb128i32(wasm.i32$store),
      // wasm.call, ...append_code.uleb128,
      // wasm.i32$const, 2,
      // wasm.call, ...append_varuint32.uleb128,
      // wasm.i32$const, 0,
      // wasm.call, ...append_varuint32.uleb128,
      wasm.call, ...end_func.uleb128,
	    //wasm.local$tee, ...func,
	    //wasm.local$get, ...func,
	    //wasm.call, ...print_i32.uleb128,
      wasm.call, ...add_to_start_func.uleb128,
      wasm.local$get, ...env,
      wasm.i32$const, ...sleb128i32(make_keyword("compile")),
      wasm.i32$const, nil,
      wasm.call, ...get.uleb128,
      wasm.call, ...atom_deref.uleb128,
      wasm.if, wasm.void,
        wasm.call, ...compile.uleb128,
      wasm.end,
      wasm.local$get, ...env,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...new_form,
      wasm.local$get, ...form,
      wasm.i32$ne,
//wasm.local$get, ...form,
////wasm.call, ...types.Seq.fields.root.uleb128,
////wasm.call, ...types.ConsSeq.fields.rest.uleb128,
//wasm.i32$const, 1,
//wasm.i32$const, nil,
//wasm.call, ...nth.uleb128,
//wasm.call, ...read_refs.uleb128,
//wasm.call, ...print_i32.uleb128,
      wasm.if, wasm.void,
//wasm.local$get, ...form,
////wasm.call, ...types.Seq.fields.root.uleb128,
////wasm.call, ...types.ConsSeq.fields.rest.uleb128,
//wasm.i32$const, 1,
//wasm.i32$const, nil,
//wasm.call, ...nth.uleb128,
	    //wasm.local$get, ...new_form,
	    //wasm.call, ...print_coll_refs.uleb128,
	    //wasm.drop,
	    //wasm.local$get, ...new_form,
	    //wasm.i32$const, 1,
	    //wasm.i32$const, nil,
	    //wasm.call, ...nth.uleb128,
	    //wasm.call, ...read_refs.uleb128,
	    //wasm.call, ...print_i32.uleb128,
	    //wasm.local$get, ...new_form,
	    //wasm.call, ...types.Seq.fields.root.uleb128,
	    //wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
	    //wasm.call, ...local_free_is_external.uleb128,
	    //wasm.call, ...read_refs.uleb128,
	    //wasm.call, ...print_i32.uleb128,
	    //wasm.local$get, ...new_form,
	    //wasm.call, ...print_coll_refs.uleb128,
	    //wasm.drop,
        wasm.local$get, ...new_form,
        wasm.call, ...free.uleb128,
	    //wasm.local$get, ...form,
	    //wasm.i32$const, 0,
	    //wasm.i32$const, nil,
	    //wasm.call, ...nth.uleb128,
	    //wasm.call, ...read_refs.uleb128,
	    //wasm.call, ...print_i32.uleb128,
	    //wasm.local$get, ...form,
	    //wasm.i32$const, 1,
	    //wasm.i32$const, nil,
	    //wasm.call, ...nth.uleb128,
	    //wasm.call, ...read_refs.uleb128,
	    //wasm.call, ...print_i32.uleb128,
	    //wasm.local$get, ...form,
	    //wasm.call, ...print_coll_refs.uleb128,
	    //wasm.drop,
//wasm.local$get, ...form,
//wasm.call, ...types.Seq.fields.root.uleb128,
//wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
//wasm.call, ...read_refs.uleb128,
//wasm.call, ...print_i32.uleb128,
//wasm.local$get, ...form,
//wasm.call, ...types.Seq.fields.root.uleb128,
//wasm.call, ...types.VectorSeq.fields.vec.uleb128,
////wasm.i32$const, 0,
////wasm.i32$const, nil,
////wasm.call, ...nth.uleb128,
//wasm.call, ...read_refs.uleb128,
//wasm.call, ...print_i32.uleb128,
      wasm.end,
//wasm.local$get, ...form,
//wasm.call, ...types.Seq.fields.root.uleb128,
//wasm.call, ...types.VectorSeq.fields.vec.uleb128,
//wasm.call, ...read_refs.uleb128,
//wasm.call, ...print_i32.uleb128,
      wasm.local$get, ...form,
      wasm.call, ...free.uleb128,
	 
//wasm.i32$const, ...sleb128i32(next_addr),
//wasm.i32$load, 2, 0,
//wasm.local$get, ...a,
//wasm.i32$sub,
//wasm.call, ...print_i32.uleb128,
      //wasm.local$get, ...out,
      //wasm.i32$load, 2, 0,
      //wasm.local$get, ...out,
      //wasm.i32$const, 4,
      //wasm.call, ...free_mem.uleb128,
    ];
  }
);

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

const is_line_terminator = funcs.build(
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

const is_whitespace = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (chr, incl_line_term) {
    return [
      ...expand_switch(
        chr, [
          wasm.local$get, ...incl_line_term,
          wasm.if, wasm.i32,
            wasm.local$get, ...chr,
            wasm.call, ...is_line_terminator.uleb128,
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

const trim_left = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32], {},
  function (str, incl_newline) {
    const idx = this.local(wasm.i32),
          chr = this.local(wasm.i32);
    return [
      wasm.loop, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...get_codepoint.uleb128,
        wasm.local$set, ...idx,
        wasm.local$tee, ...chr,
        wasm.if, wasm.void,
          wasm.local$get, ...chr,
          wasm.local$get, ...incl_newline,
          wasm.call, ...is_whitespace.uleb128,
          wasm.br_if, 1,
        wasm.end,
      wasm.end,
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$sub,
      wasm.local$tee, ...idx,
      wasm.call, ...substring_to_end.uleb128
    ];
  }
);

/*------------------------*\
|                          |
| parse & eval source code |
|                          |
\*------------------------*/

const read_form = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {}
);

const validate_boundary = funcs.build(
  [wasm.i32, wasm.i32], [wasm.i32, wasm.i32], {},
  function (str, idx) {
    const chr = this.local(wasm.i32),
          after = this.local(wasm.i32),
          valid = this.local(wasm.i32);
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.call, ...get_codepoint.uleb128,
      wasm.local$set, ...after,
      wasm.local$tee, ...chr,
      wasm.i32$const, 1,
      wasm.call, ...is_whitespace.uleb128,
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
              wasm.local$get, ...chr,
              wasm.i32$const, ...sleb128i32(";".codePointAt(0)),
              wasm.i32$eq,
              wasm.if, wasm.i32,
                wasm.i32$const, 1,
              wasm.else,
                wasm.i32$const, 0,
              wasm.end,
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

const numeric_value_of_char = funcs.build(
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

// todo: fraction syntax?
const parse_number = funcs.build(
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
        wasm.call, ...get_codepoint.uleb128,
        wasm.local$set, ...idx,
        wasm.i32$const, ...sleb128i32(45), // -
        wasm.i32$eq,
        wasm.local$set, ...has_sign,
      wasm.end,
      wasm.loop, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.local$tee, ...tmp,
        wasm.call, ...get_codepoint.uleb128,
        wasm.local$set, ...idx,
        wasm.local$tee, ...chr,
        wasm.local$get, ...base,
        wasm.i32$wrap_i64,
        wasm.i32$const, ...sleb128i32("0".codePointAt(0)),
        wasm.call, ...numeric_value_of_char.uleb128,
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
        wasm.call, ...pow.uleb128,
        wasm.f64$mul,
        wasm.local$get, ...frc_div,
        wasm.f64$div,
        wasm.call, ...types.Float.constr.uleb128,
      wasm.else,
        wasm.local$get, ...num,
        wasm.call, ...types.Int.constr.uleb128,
      wasm.end,
      wasm.local$get, ...tmp,
      wasm.local$get, ...lineno,
    ];
  }
);

// todo: reimplement in comp
const literal_tagged_data = new_method(1, 0, 0, 1, 0, 0, {});

// todo: reimplement in comp
literal_tagged_data.implement(types.Int, function (int) {
  return [
    wasm.i32$const, 2,
    wasm.call, ...refs_array_by_length.uleb128,
    wasm.i32$const, 0,
    wasm.i32$const, ...sleb128i32(make_symbol("comp.Int", "value")),
    wasm.call, ...refs_array_set.uleb128,
    wasm.i32$const, 1,
    wasm.local$get, ...int,
    wasm.call, ...refs_array_set.uleb128,
    wasm.call, ...vector_seq_from_array.uleb128
  ];
});

// todo: reimplement in comp
literal_tagged_data.implement(types.Float, function (flt) {
  return [
    wasm.i32$const, 2,
    wasm.call, ...refs_array_by_length.uleb128,
    wasm.i32$const, 0,
    wasm.i32$const, ...sleb128i32(make_symbol("comp.Float", "value")),
    wasm.call, ...refs_array_set.uleb128,
    wasm.i32$const, 1,
    wasm.local$get, ...flt,
    wasm.call, ...refs_array_set.uleb128,
    wasm.call, ...vector_seq_from_array.uleb128
  ];
});

// todo: reimplement in comp
literal_tagged_data.implement(types.Vector, function (vec) {
  const arr = this.local(wasm.i32),
        len = this.local(wasm.i32),
        idx = this.local(wasm.i32),
        val = this.local(wasm.i32),
        out = this.local(wasm.i32);
  return [
    wasm.local$get, ...vec,
    wasm.call, ...types.Vector.fields.tail.uleb128,
    wasm.call, ...types.RefsArray.fields.arr.uleb128,
    wasm.local$tee, ...arr,
    wasm.call, ...types.Array.fields.length.uleb128,
    wasm.local$tee, ...len,
    wasm.i32$const, 2,
    wasm.i32$shl,
    wasm.call, ...array_by_length.uleb128,
    wasm.local$set, ...out,
    wasm.loop, wasm.void,
      wasm.local$get, ...idx,
      wasm.local$get, ...len,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...arr,
        wasm.local$get, ...idx,
        wasm.call, ...array_get_i32.uleb128,
        wasm.local$tee, ...val,
        wasm.call, ...types.Int.pred.uleb128,
        wasm.if, wasm.void,
          wasm.local$get, ...out,
          wasm.local$get, ...idx,
          wasm.local$get, ...val,
          wasm.call, ...types.Int.fields.value.uleb128,
          wasm.call, ...array_set_i64.uleb128,
          wasm.drop,
        wasm.else,
          wasm.local$get, ...val,
          wasm.call, ...types.Float.pred.uleb128,
          wasm.if, wasm.void,
            wasm.local$get, ...out,
            wasm.local$get, ...idx,
            wasm.local$get, ...val,
            wasm.call, ...types.Float.fields.value.uleb128,
            wasm.call, ...array_set_f64.uleb128,
            wasm.drop,
          wasm.else,
            wasm.i32$const, 0,
            wasm.i32$const, ...sleb128i32(cached_string("literal-tagged-data#vector")),
            wasm.call, ...types.Exception.constr.uleb128,
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
    wasm.call, ...free.uleb128,
    wasm.local$get, ...out
  ];
});

// todo: reimplement in comp
const parse_tagged_data = funcs.build(
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
      wasm.call, ...read_form.uleb128,
      wasm.local$set, ...lineno,
      wasm.local$set, ...idx,
      wasm.local$tee, ...tag,
      wasm.call, ...types.Symbol.pred.uleb128,
      wasm.if, wasm.i32,
        wasm.local$get, ...tag,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.local$get, ...lineno,
        wasm.call, ...read_form.uleb128,
        wasm.local$set, ...lineno,
        wasm.local$set, ...idx,
        wasm.call, ...types.TaggedData.constr.uleb128,
      wasm.else,
        wasm.local$get, ...tag,
        wasm.call, ...literal_tagged_data.uleb128,
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
        wasm.call, ...string_matches_at.uleb128,
        wasm.if, wasm.i32,
          wasm.local$get, ...idx,
          wasm.i32$const, ...sleb128i32(cmpr),
          wasm.call, ...count.uleb128,
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

// todo: handle /
const symbol_start_chars = [
  "!", "$", "%", "&", "*", "+", "-", ".", "_", "|",
  ...range(48, 57), ...range(60, 63), ...range(65, 90),
  ...range(97, 122), ...range(192, 214), ...range(216, 246),
  ...range(248, 255)
];

// todo: autoresolve namespace
const parse_symbol = funcs.build(
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
      // skip the colon if it's kw
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
            wasm.call, ...substring_until.uleb128,
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
      wasm.call, ...substring_until.uleb128,
      wasm.local$set, ...nm,
      wasm.local$get, ...iskw,
      wasm.if, wasm.i32,
        wasm.local$get, ...ns,
        wasm.local$get, ...nm,
        wasm.i32$const, 1,
        wasm.call, ...keyword.uleb128,
      wasm.else,
        wasm.local$get, ...ns,
        wasm.i32$eqz,
        wasm.if, wasm.i32,
          wasm.local$get, ...nm,
          wasm.i32$const, ...sleb128i32(cached_string("nil")),
          wasm.call, ...eq.uleb128,
          wasm.if, wasm.i32,
            wasm.i32$const, nil,
            wasm.local$set, ...out,
            wasm.i32$const, 1,
          wasm.else,
            wasm.local$get, ...nm,
            wasm.i32$const, ...sleb128i32(cached_string("true")),
            wasm.call, ...eq.uleb128,
            wasm.if, wasm.i32,
              wasm.i32$const, ...sleb128i32(comp_true),
              wasm.local$set, ...out,
              wasm.i32$const, 1,
            wasm.else,
              wasm.local$get, ...nm,
              wasm.i32$const, ...sleb128i32(cached_string("false")),
              wasm.call, ...eq.uleb128,
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
          wasm.call, ...symbol.uleb128,
          wasm.local$get, ...ns,
          wasm.call, ...free.uleb128,
          wasm.local$get, ...nm,
          wasm.call, ...free.uleb128,
        wasm.end,
      wasm.end,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

const parse_coll_recur = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno, delim, cnt) {
    const tmp = this.local(wasm.i32),
          cdp = this.local(wasm.i32),
          arr = this.local(wasm.i32),
          val = this.local(wasm.i32);
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.call, ...get_codepoint.uleb128,
      wasm.local$set, ...tmp,
      wasm.local$tee, ...cdp,
      wasm.i32$const, 1,
      wasm.call, ...is_whitespace.uleb128,
      wasm.if, wasm.void,
// todo: inc lineno if linebreak?
        wasm.local$get, ...str,
        wasm.local$get, ...tmp,
        wasm.local$get, ...lineno,
        wasm.local$get, ...delim,
        wasm.local$get, ...cnt,
        wasm.call, ...this.uleb128,
        wasm.local$set, ...lineno,
        wasm.local$set, ...idx,
        wasm.local$set, ...arr,
      wasm.else,
        wasm.local$get, ...cdp,
        wasm.local$get, ...delim,
        wasm.i32$eq,
        wasm.if, wasm.void,
          wasm.local$get, ...cnt,
          wasm.call, ...refs_array_by_length.uleb128,
          wasm.local$set, ...arr,
          wasm.local$get, ...tmp,
          wasm.local$set, ...idx,
        wasm.else,
          wasm.local$get, ...str,
          wasm.local$get, ...idx,
          wasm.local$get, ...lineno,
          wasm.call, ...read_form.uleb128,
          wasm.local$set, ...lineno,
          wasm.local$set, ...idx,
          wasm.local$set, ...val,
          wasm.local$get, ...str,
          wasm.local$get, ...idx,
          wasm.local$get, ...lineno,
          wasm.local$get, ...delim,
          wasm.local$get, ...cnt,
          wasm.i32$const, 1,
          wasm.i32$add,
          wasm.call, ...this.uleb128,
          wasm.local$set, ...lineno,
          wasm.local$set, ...idx,
          wasm.local$get, ...cnt,
          wasm.local$get, ...val,
          wasm.call, ...refs_array_set_no_inc.uleb128,
          wasm.local$set, ...arr,
        wasm.end,
      wasm.end,
      wasm.local$get, ...arr,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

const parse_coll = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno, delim) {
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$get, ...lineno,
      wasm.local$get, ...delim,
      wasm.i32$const, 0,
      wasm.call, ...parse_coll_recur.uleb128
    ];
  }
);

const parse_list = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    const arr = this.local(wasm.i32);
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno,
      wasm.i32$const, ...sleb128i32(")".codePointAt(0)),
      wasm.call, ...parse_coll.uleb128,
      wasm.local$set, ...lineno,
      wasm.local$set, ...idx,
      wasm.local$tee, ...arr,
      wasm.call, ...to_seq.uleb128,
      wasm.local$get, ...arr,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

const parse_vector = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    const arr = this.local(wasm.i32);
    return [
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno,
      wasm.i32$const, ...sleb128i32("]".codePointAt(0)),
      wasm.call, ...parse_coll.uleb128,
      wasm.local$set, ...lineno,
      wasm.local$set, ...idx,
      wasm.local$tee, ...arr,
      wasm.call, ...vector_from_array.uleb128,
      wasm.local$get, ...arr,
      wasm.call, ...free.uleb128,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno,
    ];
  }
);

const parse_map = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    const seq = this.local(wasm.i32),
          cnt = this.local(wasm.i32),
          key = this.local(wasm.i32),
          val = this.local(wasm.i32),
          n = this.local(wasm.i32),
          map = this.local(wasm.i32);
    return [
      wasm.i32$const, ...sleb128i32(empty_hash_map),
      wasm.local$set, ...map,
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno,
      wasm.i32$const, ...sleb128i32("}".codePointAt(0)),
      wasm.call, ...parse_coll.uleb128,
      wasm.local$set, ...lineno,
      wasm.local$set, ...idx,
      wasm.call, ...to_seq.uleb128,
      wasm.local$tee, ...seq,
      wasm.call, ...count.uleb128,
      wasm.local$tee, ...cnt,
      wasm.if, wasm.void,
        wasm.loop, wasm.void,
          wasm.local$get, ...n,
          wasm.local$get, ...cnt,
          wasm.i32$lt_u,
          wasm.if, wasm.void,
            wasm.local$get, ...map,
            wasm.local$get, ...seq,
            wasm.local$get, ...n,
            wasm.i32$const, nil,
            wasm.call, ...nth.uleb128,
            wasm.local$tee, ...key,
            wasm.local$get, ...seq,
            wasm.local$get, ...n,
            wasm.i32$const, 1,
            wasm.i32$add,
            wasm.i32$const, nil,
            wasm.call, ...nth.uleb128,
            wasm.local$tee, ...val,
            wasm.call, ...assoc.uleb128,
            wasm.local$get, ...map,
            wasm.call, ...free.uleb128,
            wasm.local$get, ...key,
            wasm.call, ...free.uleb128,
// todo: why can't we free?
            //wasm.local$get, ...val,
            //wasm.call, ...free.uleb128,
            wasm.local$set, ...map,
            wasm.local$get, ...n,
            wasm.i32$const, 2,
            wasm.i32$add,
            wasm.local$set, ...n,
            wasm.br, 1,
          wasm.end,
        wasm.end,
        wasm.local$get, ...seq,
        wasm.call, ...types.Seq.fields.root.uleb128,
        wasm.call, ...types.RefsArraySeq.fields.arr.uleb128,
        wasm.call, ...free.uleb128,
        wasm.local$get, ...seq,
        wasm.call, ...free.uleb128,
      wasm.end,
      wasm.local$get, ...map,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

const parse_quote = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32, wasm.i32], {},
  function (str, idx, lineno, sym) {
    return [
      wasm.i32$const, 2,
      wasm.call, ...refs_array_by_length.uleb128,
      wasm.i32$const, 0,
      wasm.local$get, ...sym,
      wasm.call, ...inc_refs.uleb128,
      wasm.call, ...refs_array_set.uleb128,
      wasm.i32$const, 1,
      wasm.local$get, ...str,
      wasm.local$get, ...idx,
      wasm.i32$const, 1,
      wasm.i32$add,
      wasm.local$get, ...lineno,
      wasm.call, ...read_form.uleb128,
      wasm.local$set, ...lineno,
      wasm.local$set, ...idx,
      wasm.call, ...refs_array_set.uleb128,
      wasm.call, ...vector_seq_from_array.uleb128,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

const parse_comment = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32], {},
  function (str, idx, lineno) {
    return [
      wasm.loop, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...get_codepoint.uleb128,
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

const parse_string = funcs.build(
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
        wasm.call, ...get_codepoint.uleb128,
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
            wasm.call, ...substring_until.uleb128,
            wasm.local$set, ...segment,
            wasm.local$get, ...out,
            wasm.if, wasm.i32,
              wasm.local$get, ...out,
              wasm.local$get, ...segment,
              wasm.call, ...concat_str.uleb128,
              wasm.local$get, ...out,
              wasm.call, ...free.uleb128,
              wasm.local$get, ...segment,
              wasm.call, ...free.uleb128,
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
      wasm.call, ...substring_until.uleb128,
      wasm.local$set, ...segment,
      wasm.local$get, ...out,
      wasm.if, wasm.i32,
        wasm.local$get, ...out,
        wasm.local$get, ...segment,
        wasm.call, ...concat_str.uleb128,
        wasm.local$get, ...out,
        wasm.call, ...free.uleb128,
        wasm.local$get, ...segment,
        wasm.call, ...free.uleb128,
      wasm.else,
        wasm.local$get, ...segment,
        wasm.call, ...force_to_string.uleb128,
      wasm.end,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

read_form.build(function (str, idx, lineno) {
  const org_idx = this.local(wasm.i32),
        match_idx = this.local(wasm.i32),
        out = this.local(wasm.i32),
        wts = this.local(wasm.i32),
        len = this.local(wasm.i32),
        chr = this.local(wasm.i32),
        tmp = this.local(wasm.i32);
  return [
    wasm.local$get, ...idx,
    wasm.local$set, ...org_idx,
    wasm.local$get, ...str,
    wasm.call, ...count.uleb128,
    wasm.local$set, ...len,
    wasm.loop, wasm.void,
      wasm.local$get, ...idx,
      wasm.local$get, ...len,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.call, ...get_codepoint.uleb128,
        wasm.local$set, ...tmp,
        wasm.local$tee, ...chr,
        wasm.i32$const, 1,
        wasm.call, ...is_whitespace.uleb128,
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
            wasm.call, ...parse_comment.uleb128,
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
              wasm.call, ...parse_number.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx,
            ],
            ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9",],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, 0,
              wasm.call, ...parse_number.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx,
            ],
            ['"'],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...parse_string.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx,
            ],
            [":"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, 1,
              wasm.call, ...parse_symbol.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx,
            ],
            symbol_start_chars,
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, 0,
              wasm.call, ...parse_symbol.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx,
            ],
            ["("],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...parse_list.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["["],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...parse_vector.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["{"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...parse_map.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["#"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.call, ...parse_tagged_data.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["'"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, ...sleb128i32(cached_string("comp")),
              wasm.i32$const, ...sleb128i32(cached_string("quote")),
              wasm.call, ...symbol.uleb128,
              wasm.call, ...parse_quote.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["`"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, ...sleb128i32(cached_string("comp")),
              wasm.i32$const, ...sleb128i32(cached_string("syntax-quote")),
              wasm.call, ...symbol.uleb128,
              wasm.call, ...parse_quote.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
            ["~"],
            [
              wasm.local$get, ...str,
              wasm.local$get, ...idx,
              wasm.local$get, ...lineno,
              wasm.i32$const, ...sleb128i32(cached_string("comp")),
              wasm.i32$const, ...sleb128i32(cached_string("unquote")),
              wasm.call, ...symbol.uleb128,
              wasm.call, ...parse_quote.uleb128,
              wasm.local$set, ...lineno,
              wasm.local$set, ...idx
            ],
          ),
          wasm.local$get, ...str,
          wasm.local$get, ...idx,
          wasm.call, ...validate_boundary.uleb128,
          wasm.local$set, ...idx,
          wasm.i32$eqz,
          wasm.if, wasm.void,
            wasm.local$get, ...str,
            wasm.i32$const, ...sleb128i32(cached_string("[syntax error] invalid or unexpected token: ")),
            wasm.local$get, ...str,
            wasm.local$get, ...org_idx,
            wasm.local$get, ...idx,
            wasm.call, ...substring_until.uleb128,
            wasm.call, ...concat_str.uleb128,
            wasm.throw, 0,
          wasm.end,
          wasm.local$set, ...out,
        wasm.end,
      wasm.end,
    wasm.end,
    wasm.local$get, ...out,
    wasm.local$get, ...idx,
    wasm.local$get, ...lineno
  ];
});

const eval_stream = funcs.build(
  [wasm.i32, wasm.i32, wasm.i32],
  [wasm.i32, wasm.i32], { export: "eval_stream" },
  function (str, idx, lineno) {
    const form = this.local(wasm.i32);
    return [
      wasm.local$get, ...idx,
      wasm.local$get, ...str,
      wasm.call, ...count.uleb128,
      wasm.i32$lt_u,
      wasm.if, wasm.void,
        wasm.local$get, ...str,
        wasm.local$get, ...idx,
        wasm.local$get, ...lineno,
        wasm.call, ...read_form.uleb128,
        wasm.local$set, ...lineno,
        wasm.local$set, ...idx,
        wasm.local$tee, ...form,
        wasm.call, ...compile_form.uleb128,
// todo: recursive?
        //wasm.call, ...free.uleb128,
      wasm.end,
      wasm.local$get, ...idx,
      wasm.local$get, ...lineno
    ];
  }
);

cached_strings = {};

// END COMP

begin_package();

// thread_port = comp.alloc(8);

// todo: this is changing address 0 (nil)

// if (!main_env.is_main) {
//   const tgt = (new DataView(memory.buffer)).getUint32(main_env.thread_port, true);
//   // comp.add_watch(tgt);
// } else {
//   comp.watch(comp.Atom(nil), 3);
// }

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

end_package();

while (funcs.comp.length) {
  let [nm, ...rest] = funcs.comp.pop();
  if (nm instanceof Array) {
    nm = make_keyword(nm[0], nm[1]);
  } else {
    nm = make_keyword("comp", nm);
  }
  comp.store_comp_func(nm, ...rest);
}

begin_package();

function eval_file (f, interpret) {
// todo: change to createReadStream
  const fd = fs.openSync(f, "r"),
        len = fs.fstatSync(fd).size,
        file = comp.File(fd, len),
        fsl = comp.FileSlice(file, 0, len);
  let idx = 0,
      lineno = 0;
  while (idx < len) {
    [idx, lineno] = comp.eval_stream(fsl, idx, lineno, 0);
  }
  if (interpret) compile();
  comp.free(file);
}

try {
  if (start_funcs_len) start_funcs.push(...new Uint32Array(start_funcs_buf));

  compile();

  if (!main_env.is_browser) {
    for (const file of argv.files) eval_file(file, !argv.compile);
	//console.dir(module_sections[table_section],{maxArrayLength:null});
    if (argv.compile) fs.writeFile(argv.compile, build_package(), () => null);
  }
} catch (e) {
  if (e instanceof WebAssembly.Exception && e.is(exception_tag)) {
    const exc = e.getArg(exception_tag, 0);
    console.log(comp_string_to_js(comp.Exception$msg(exc)));
    return;
  }
  throw(e);
}

console.timeEnd("all");

end_package();

}

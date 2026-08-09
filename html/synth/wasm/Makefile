# MSFA DX7 WASM build — compiles patched Go MSFA to WebAssembly
# Requires: emcc (Emscripten SDK)

MSFA = ../../../external/msfa

SRC = $(MSFA)/wrapper.cc \
      $(MSFA)/synth_unit.cc \
      $(MSFA)/ringbuffer.cc \
      $(MSFA)/patch.cc \
      $(MSFA)/lfo.cc \
      $(MSFA)/dx7note.cc \
      $(MSFA)/freqlut.cc \
      $(MSFA)/sin.cc \
      $(MSFA)/exp2.cc \
      $(MSFA)/fm_core.cc \
      $(MSFA)/fm_op_kernel.cc \
      $(MSFA)/pitchenv.cc \
      $(MSFA)/env.cc \
      $(MSFA)/resofilter.cc \
      $(MSFA)/fir.cc \
      $(MSFA)/log2.cc

CFLAGS = -I$(MSFA) -O2 -Wno-logical-op-parentheses

JSFLAGS = -s WASM=1 \
          -s ALLOW_MEMORY_GROWTH=1 \
          -s BINARYEN_ASYNC_COMPILATION=0 \
          -s MODULARIZE=0 \
          -s EXPORT_NAME="'DX7Module'" \
          -s EXPORTED_FUNCTIONS='["_dx7_global_init","_dx7_ringbuffer_create","_dx7_ringbuffer_destroy","_dx7_ringbuffer_write","_dx7_synth_create","_dx7_synth_destroy","_dx7_get_samples","_dx7_set_voice","_dx7_set_bank","_dx7_get_bank","_dx7_set_channel_volume","_dx7_unpack_patch","_malloc","_free","_init_engine","_load_voice","_load_voice_channel","_send_midi","_note_on","_note_off","_render_audio"]' \
          -s EXPORTED_RUNTIME_METHODS='["cwrap","getValue","setValue","HEAP8","HEAP16","HEAP32","HEAPF32"]' \
          -s ENVIRONMENT='web,worker'

TARGET = dx7.js

.PHONY: all clean

all: $(TARGET) dx7.wasm.js

$(TARGET): $(SRC)
	emcc $(CFLAGS) $(JSFLAGS) -o $@ $(SRC)

dx7.wasm.js: dx7.wasm
	node ../../external/webdx7/build/encode-wasm.js dx7.wasm

clean:
	rm -f dx7.js dx7.wasm dx7.wasm.js

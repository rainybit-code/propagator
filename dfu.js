/* ============================================================================
   dfu.js — WebUSB DfuSe flasher for Spore.
   SPDX-License-Identifier: GPL-3.0-or-later
   Copyright (C) 2026 Joakim Langkilde
   Adapted from webdfu by Devan Lai (https://github.com/devanlai/webdfu, MIT).

   Enumerates the STM32 ROM bootloader (VID 0x0483 / PID 0xDF11), reads its DfuSe
   memory map, and flashes a raw .bin to internal flash at 0x08000000.

   Exposes a global `WebDFU` with:
     WebDFU.supported()                      -> boolean (navigator.usb present)
     await WebDFU.requestDevice()            -> DfuseDevice (opens the picker)
     await dev.connect()                     -> claim interface, parse memory map
     await dev.download(arrayBuffer, addr, onProgress)   -> erase+write+manifest
     await dev.close()
   ========================================================================== */
(function () {
    'use strict';

    // DFU class requests (USB DFU 1.1)
    const REQ = {
        DETACH: 0,
        DNLOAD: 1,
        UPLOAD: 2,
        GETSTATUS: 3,
        CLRSTATUS: 4,
        GETSTATE: 5,
        ABORT: 6,
    };
    // DFU states
    const ST = {
        appIDLE: 0,
        appDETACH: 1,
        dfuIDLE: 2,
        dfuDNLOAD_SYNC: 3,
        dfuDNBUSY: 4,
        dfuDNLOAD_IDLE: 5,
        dfuMANIFEST_SYNC: 6,
        dfuMANIFEST: 7,
        dfuMANIFEST_WAIT_RESET: 8,
        dfuUPLOAD_IDLE: 9,
        dfuERROR: 10,
    };
    // DfuSe special commands (written to block 0)
    const DFUSE = { GET_COMMANDS: 0x00, SET_ADDRESS: 0x21, ERASE_SECTOR: 0x41 };

    const STM_VID = 0x0483,
        STM_DFU_PID = 0xdf11;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    function hex(n) {
        return '0x' + (n >>> 0).toString(16).toUpperCase().padStart(8, '0');
    }

    // Parse a DfuSe alt-setting name like "@Internal Flash /0x08000000/01*128Kg"
    // into { name, segments:[{start,end,sectorSize,erasable,writable}] }.
    function parseMemory(desc) {
        if (!desc || desc[0] !== '@') return null;
        const parts = desc.split('/');
        const name = parts[0].replace(/^@\s*/, '').trim();
        if (parts.length < 3) return { name, segments: [] };
        const segments = [];
        for (let i = 1; i + 1 < parts.length; i += 2) {
            let start = parseInt(parts[i], 16);
            const sectors = parts[i + 1].split(',');
            for (const s of sectors) {
                const m = /(\d+)\s*\*\s*(\d+)\s*([KM]?)\s*([a-g])/i.exec(s.trim());
                if (!m) continue;
                const count = parseInt(m[1], 10);
                let size = parseInt(m[2], 10);
                if (m[3].toUpperCase() === 'K') size *= 1024;
                else if (m[3].toUpperCase() === 'M') size *= 1024 * 1024;
                const t = m[4].toLowerCase().charCodeAt(0) - 'a'.charCodeAt(0); // bitfield
                const readable = !!(t & 1),
                    erasable = !!(t & 2),
                    writable = !!(t & 4);
                segments.push({
                    start,
                    end: start + count * size,
                    sectorSize: size,
                    count,
                    readable,
                    erasable,
                    writable,
                });
                start += count * size;
            }
        }
        return { name, segments };
    }

    class DfuseDevice {
        constructor(usbDevice, ifaceNumber, altSetting, memDesc) {
            this.dev = usbDevice;
            this.ifaceNumber = ifaceNumber;
            this.altSetting = altSetting;
            this.memory = parseMemory(memDesc);
            this.transferSize = 1024; // overwritten from the DFU functional descriptor
        }

        // ---- low-level control transfers (class requests on the interface) ----
        _out(request, value, data) {
            return this.dev.controlTransferOut(
                {
                    requestType: 'class',
                    recipient: 'interface',
                    request,
                    value,
                    index: this.ifaceNumber,
                },
                data,
            );
        }
        _in(request, value, length) {
            return this.dev.controlTransferIn(
                {
                    requestType: 'class',
                    recipient: 'interface',
                    request,
                    value,
                    index: this.ifaceNumber,
                },
                length,
            );
        }

        async getStatus() {
            const r = await this._in(REQ.GETSTATUS, 0, 6);
            if (r.status !== 'ok' || r.data.byteLength < 6) throw new Error('GETSTATUS failed');
            const d = r.data;
            return {
                status: d.getUint8(0),
                pollTimeout: d.getUint8(1) | (d.getUint8(2) << 8) | (d.getUint8(3) << 16),
                state: d.getUint8(4),
            };
        }
        async clearStatus() {
            await this._out(REQ.CLRSTATUS, 0);
        }
        async abortToIdle() {
            await this._out(REQ.ABORT, 0);
            let s = await this.getStatus();
            if (s.state === ST.dfuERROR) {
                await this.clearStatus();
                s = await this.getStatus();
            }
            return s;
        }

        // Wait while the device is busy (dfuDNBUSY), honouring its requested poll timeout.
        async pollUntilIdle(targetState) {
            let s = await this.getStatus();
            while (s.state !== targetState && s.state !== ST.dfuERROR) {
                await delay(s.pollTimeout);
                s = await this.getStatus();
            }
            if (s.state === ST.dfuERROR) throw new Error('DFU error, status=' + s.status);
            return s;
        }

        // Issue a DfuSe command via block 0 (set-address / erase-sector).
        async _dfuseCommand(command, param) {
            const hasParam = command !== DFUSE.GET_COMMANDS;
            const buf = new ArrayBuffer(hasParam ? 5 : 1);
            const v = new DataView(buf);
            v.setUint8(0, command);
            if (hasParam) v.setUint32(1, param, true); // little-endian address
            try {
                await this._out(REQ.DNLOAD, 0, buf);
            } catch (e) {
                throw new Error('DfuSe command ' + command + ' failed to start');
            }
            // first GETSTATUS triggers execution (dfuDNBUSY), then poll back to idle
            const s0 = await this.getStatus();
            await delay(s0.pollTimeout);
            const s1 = await this.pollUntilIdle(ST.dfuDNLOAD_IDLE);
            return s1;
        }

        _segmentFor(addr) {
            if (!this.memory) return null;
            return this.memory.segments.find((s) => addr >= s.start && addr < s.end) || null;
        }

        // Erase every sector overlapping [startAddr, startAddr+length).
        async erase(startAddr, length, onProgress) {
            const end = startAddr + length;
            let addr = startAddr;
            // align down to sector boundary of the containing segment
            const seg0 = this._segmentFor(addr);
            if (seg0)
                addr =
                    seg0.start +
                    Math.floor((addr - seg0.start) / seg0.sectorSize) * seg0.sectorSize;
            while (addr < end) {
                const seg = this._segmentFor(addr);
                if (!seg) throw new Error('No flash sector at ' + hex(addr));
                await this._dfuseCommand(DFUSE.ERASE_SECTOR, addr);
                addr += seg.sectorSize;
                if (onProgress) onProgress(Math.min(1, (addr - startAddr) / length));
            }
        }

        // Flash `data` (ArrayBuffer) to `startAddr`. Erases first, then streams blocks,
        // then manifests (which reboots into the new app).
        async download(data, startAddr, onProgress) {
            const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
            const total = bytes.byteLength;
            if (!total) throw new Error('Empty firmware file');

            // make sure we start from a clean idle state
            await this.abortToIdle();

            if (onProgress) onProgress({ phase: 'erase', ratio: 0 });
            await this.erase(
                startAddr,
                total,
                (r) => onProgress && onProgress({ phase: 'erase', ratio: r }),
            );

            // set the address pointer once; data blocks (wBlockNum>=2) auto-advance from here
            await this._dfuseCommand(DFUSE.SET_ADDRESS, startAddr);

            let sent = 0,
                block = 2;
            const xfer = this.transferSize || 1024;
            if (onProgress) onProgress({ phase: 'write', ratio: 0 });
            while (sent < total) {
                const chunk = bytes.slice(sent, sent + xfer);
                try {
                    await this._out(REQ.DNLOAD, block, chunk);
                } catch (e) {
                    throw new Error('Write failed at block ' + block);
                }
                // execute + wait
                const s0 = await this.getStatus();
                await delay(s0.pollTimeout);
                await this.pollUntilIdle(ST.dfuDNLOAD_IDLE);
                sent += chunk.byteLength;
                block += 1;
                if (onProgress) onProgress({ phase: 'write', ratio: sent / total });
            }

            // manifest: zero-length DNLOAD tells the device we're done -> it programs & resets
            if (onProgress) onProgress({ phase: 'manifest', ratio: 1 });
            try {
                await this._out(REQ.DNLOAD, 0, new ArrayBuffer(0));
            } catch (e) {
                /* ignore */
            }
            try {
                const s = await this.getStatus(); // may begin manifestation
                await delay(s.pollTimeout);
                // The device typically detaches/resets here; a failing GETSTATUS is expected.
                await this.getStatus().catch(() => {});
            } catch (e) {
                /* device reset — success */
            }
        }

        // Leave DFU and boot the application at `appAddr` (default the flash base) without
        // flashing. DfuSe interprets a zero-length DNLOAD after a SET_ADDRESS as
        // "jump there + reset" — the same tail step download() uses to reboot post-flash.
        async leave(appAddr) {
            const addr =
                (appAddr == null
                    ? (this.memory && this.memory.segments[0] && this.memory.segments[0].start) ||
                      0x08000000
                    : appAddr) >>> 0;
            await this.abortToIdle().catch(() => {});
            await this._dfuseCommand(DFUSE.SET_ADDRESS, addr);
            try {
                await this._out(REQ.DNLOAD, 0, new ArrayBuffer(0));
            } catch (e) {
                /* ignore */
            }
            // GETSTATUS triggers the jump/reset; the device detaches, so a failing read is expected.
            try {
                const s = await this.getStatus();
                await delay(s.pollTimeout);
            } catch (e) {}
            await this.getStatus().catch(() => {});
        }

        async connect() {
            await this.dev.open();
            if (this.dev.configuration === null) await this.dev.selectConfiguration(1);
            await this.dev.claimInterface(this.ifaceNumber);
            if (this.altSetting != null) {
                try {
                    await this.dev.selectAlternateInterface(this.ifaceNumber, this.altSetting);
                } catch (e) {
                    /* some stacks reject; usually fine */
                }
            }
            // read transferSize from the DFU functional descriptor (best-effort)
            await this._readTransferSize().catch(() => {});
            // Chrome can leave alt.interfaceName empty (seen on Linux), so the DfuSe memory
            // map never parsed. Re-read it straight off the device by string index.
            if (!this.memory || !this.memory.segments.length) {
                await this._readMemoryString().catch(() => {});
            }
            // start from a known-idle state
            await this.abortToIdle().catch(() => {});
            return this;
        }

        async close() {
            try {
                await this.dev.releaseInterface(this.ifaceNumber);
            } catch (e) {}
            try {
                await this.dev.close();
            } catch (e) {}
        }

        // Fetch the full configuration descriptor as a Uint8Array (best-effort, null on failure).
        async _getConfigDescriptor() {
            const GET_DESCRIPTOR = 0x06,
                DT_CONFIG = 0x02;
            const head = await this.dev.controlTransferIn(
                {
                    requestType: 'standard',
                    recipient: 'device',
                    request: GET_DESCRIPTOR,
                    value: (DT_CONFIG << 8) | 0,
                    index: 0,
                },
                4,
            );
            if (head.status !== 'ok') return null;
            const totalLen = head.data.getUint16(2, true);
            const full = await this.dev.controlTransferIn(
                {
                    requestType: 'standard',
                    recipient: 'device',
                    request: GET_DESCRIPTOR,
                    value: (DT_CONFIG << 8) | 0,
                    index: 0,
                },
                totalLen,
            );
            if (full.status !== 'ok') return null;
            return new Uint8Array(full.data.buffer);
        }

        // Find the DFU functional descriptor (0x21) and read wTransferSize (offset 5,
        // u16 LE). Falls back to 1024 on any failure.
        async _readTransferSize() {
            const buf = await this._getConfigDescriptor();
            if (!buf) return;
            let i = 0;
            while (i < buf.length) {
                const len = buf[i],
                    type = buf[i + 1];
                if (len === 0) break;
                if (type === 0x21 && i + 7 <= buf.length) {
                    // DFU functional descriptor
                    this.transferSize = buf[i + 5] | (buf[i + 6] << 8);
                    if (!this.transferSize) this.transferSize = 1024;
                    return;
                }
                i += len;
            }
        }

        // Read the alt-setting's DfuSe memory-layout string directly from the device.
        // Chrome sometimes reports an empty alt.interfaceName (observed under Chrome on
        // Linux), so we parse iInterface out of the config descriptor and fetch the string
        // ourselves — same as dfu-util does, which is why dfu-util flashes the same device.
        async _readMemoryString() {
            const buf = await this._getConfigDescriptor();
            if (!buf) return;
            let strIndex = 0,
                i = 0;
            while (i < buf.length) {
                const len = buf[i],
                    type = buf[i + 1];
                if (len === 0) break;
                if (type === 0x04 && i + 9 <= buf.length) {
                    // interface descriptor
                    const num = buf[i + 2],
                        alt = buf[i + 3],
                        iIface = buf[i + 8];
                    if (
                        num === this.ifaceNumber &&
                        (this.altSetting == null || alt === this.altSetting)
                    ) {
                        strIndex = iIface;
                        break;
                    }
                }
                i += len;
            }
            if (!strIndex) return;
            const mem = parseMemory(await this._readStringDescriptor(strIndex));
            if (mem && mem.segments.length) this.memory = mem;
        }

        // GET_DESCRIPTOR(string, index) -> decoded JS string (UTF-16LE), '' on failure.
        async _readStringDescriptor(index, langId) {
            const GET_DESCRIPTOR = 0x06,
                DT_STRING = 0x03;
            const r = await this.dev.controlTransferIn(
                {
                    requestType: 'standard',
                    recipient: 'device',
                    request: GET_DESCRIPTOR,
                    value: (DT_STRING << 8) | index,
                    index: langId || 0x0409,
                },
                255,
            );
            if (r.status !== 'ok' || r.data.byteLength < 2) return '';
            const len = Math.min(r.data.getUint8(0), r.data.byteLength);
            let s = '';
            for (let o = 2; o + 1 < len; o += 2)
                s += String.fromCharCode(r.data.getUint16(o, true));
            return s;
        }
    }

    // Find the DFU interface (class 0xFE, subclass 0x01) + its DfuSe memory string.
    async function pickDfuInterface(usbDevice) {
        await usbDevice.open();
        if (usbDevice.configuration === null) await usbDevice.selectConfiguration(1);
        const cfg = usbDevice.configuration;
        for (const iface of cfg.interfaces) {
            for (const alt of iface.alternates) {
                if (alt.interfaceClass === 0xfe && alt.interfaceSubclass === 0x01) {
                    return {
                        ifaceNumber: iface.interfaceNumber,
                        altSetting: alt.alternateSetting,
                        memDesc: alt.interfaceName || '',
                    };
                }
            }
        }
        return null;
    }

    const WebDFU = {
        STM_VID,
        STM_DFU_PID,
        supported() {
            return typeof navigator !== 'undefined' && !!navigator.usb;
        },
        async requestDevice() {
            if (!this.supported())
                throw new Error('WebUSB not available (use Chrome or Edge over https/localhost)');
            const usbDevice = await navigator.usb.requestDevice({
                filters: [{ vendorId: STM_VID, productId: STM_DFU_PID }],
            });
            const info = await pickDfuInterface(usbDevice);
            if (!info) {
                try {
                    await usbDevice.close();
                } catch (e) {}
                throw new Error('No DFU interface on this device');
            }
            return new DfuseDevice(usbDevice, info.ifaceNumber, info.altSetting, info.memDesc);
        },
    };

    if (typeof window !== 'undefined') window.WebDFU = WebDFU;
})();

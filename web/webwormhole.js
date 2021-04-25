"use strict";

// TODO: move to it's own file
const matchMessage = (type, rawMessage) => {
  if (!type) return true
  let parsed
  try {
    parsed = JSON.parse(rawMessage)
  } catch (e) {}
  return parsed?.data?.type === type
}

const wait = async (ws, type, timeout) => {
  return new Promise((resolve) => {
    let timeoutID
    if (timeout) {
      timeoutID = setTimeout(() => {
        cleanup()
        resolve([undefined, new Error('TimeoutError')])
      }, timeout)
    }

    const listener = (rawMessage) => {
      if (matchMessage(type, rawMessage)) {
        clearTimeout(timeoutID)
        cleanup()
        resolve([rawMessage])
      }
    }

    const errorListener = (error) => {
      cleanup()
      resolve([undefined, error])
    }

    const cleanup = () => {
      ws.removeEventListener('message', listener)
      ws.removeEventListener('error', errorListener)
    }

    ws.addEventListener('message', listener)
    ws.addEventListener('error', errorListener)
  })
}


class Wormhole {
	constructor(signalserver, code) {
		this.protocol = "4"; // safari has no static fields
		// There are 3 events that we need to synchronise with the caller on:
		//   1. we got the first message from the signalling server.
		//        We now have the slot number and the ICE server details, so we can
		//        create the wormhole code and PeerConnection object, and pass them back
		//        to the caller to display and configure, respectively.
		//   2. the caller is done configuring the PeerConnection.
		//        We can now create the offer or answer and send it to the peer.
		//   3. we've successfully authenticated the other peer.
		//        Signalling is now done, apart from any trickling candidates. The called
		//        can display the key fingerprint.
		//   4. (unimplemented) caller tells us the webrtc handshake is done.
		//        We can close the websocket.
		this.promise1 = new Promise((resolve1, reject1) => {
			this.promise2 = new Promise((resolve2, reject2) => {
				this.promise3 = new Promise((resolve3, reject3) => {
					// It is very possible that I do not understand how to us promises "correctly".
					this.resolve1 = resolve1;
					this.reject1 = reject1;
					this.resolve2 = resolve2;
					this.reject2 = reject2;
					this.resolve3 = resolve3;
					this.reject3 = reject3;
					this.dial(signalserver, code);
				});
			});
		});
	}

	async signal() {
		return this.promise1;
	}

	async finish() {
		this.resolve2();
		return this.promise3;
	}

	dial(signalserver, code) {
		this.ws = new WebSocket(
			Wormhole.wsserver(signalserver, this.slot),
			this.protocol,
		);
		this.ws.onopen = (a) => {
			this.onopen(a);
		};
		this.ws.onerror = (a) => {
			this.onerror(a);
		};
		this.ws.onclose = (a) => {
			this.onclose(a);
		};
		this.ws.onmessage = (a) => {
			this.onmessage(a);
		};
		
		if (code !== "") {
			[this.slot, this.pass] = webwormhole.decode(code);
			if (this.pass.length === 0) {
				throw "bad code";
			}
			console.log("dialling slot:", this.slot);
			this.state = "b";
			await this.join()
		} else {
			this.slot = "";
			this.pass = crypto.getRandomValues(new Uint8Array(2));
			console.log("requesting slot");
			this.state = "a";
			await this.new()
		}
	}


	async waitForPakeA() {
		const [m] = await wait(ws)
		console.log('got pake message a:', m.data)
		const [key, msgB] = webwormhole.exchange(this.pass, m.data)
		this.key = key
		console.log('message b:', msgB)
		if (this.key == null) return this.fail('could not generate key')
		console.log('generated key')
		this.ws.send(msgB)
		this.state = 'wait_for_pc_initialize'
		await this.promise2
		const offer = await this.pc.createOffer()
		console.log('created offer')
		this.pc.setLocalDescription(offer)
		this.ws.send(webwormhole.seal(this.key, JSON.stringify(offer)))
		this.state = 'wait_for_webtc_answer'
	}
	
	waitForWebTcAnswer() {
		const [m] = await wait()
		const msg = JSON.parse(webwormhole.open(this.key, m.data))
		if (msg == null) {
			this.fail('bad key')
			this.ws.send(webwormhole.seal(this.key, 'bye'))
			this.ws.close()
			return
		}
		if (msg.type !== 'answer') {
			console.log('unexpected message', msg)
			this.fail('unexpected message')
			return
		}
		console.log('got answer')
		this.pc.setRemoteDescription(new RTCSessionDescription(msg))
		this.resolve3(webwormhole.fingerprint(this.key))
		this.state = 'wait_for_candidates'
	}
	
	async new() {
		const [rawMessage, error] = await wait(ws)
		let msg = JSON.parse(rawMessage.data)
		console.log('assigned slot:', msg.slot)
		this.slot = parseInt(msg.slot, 10)
		if (!Number.isSafeInteger(this.slot)) return this.fail('invalid slot')
		this.newPeerConnection(msg.iceServers)
		this.resolve1({
			code: webwormhole.encode(this.slot, this.pass),
			pc: this.pc,
		})
		this.state = 'wait_for_pake_a'
		await this.waitForPakeA()
		await this.waitForWebTcAnswer()
		await this.waitForCandidates()
	}

	waitForCandidates() {
		const m = wait(ws)
		const msg = JSON.parse(webwormhole.open(this.key, m.data))
		if (msg == null) {
			this.fail('bad key')
			this.ws.send(webwormhole.seal(this.key, 'bye'))
			this.ws.close()
			return
		}
		console.log('got remote candidate', msg)
		this.promise2.then(async () => {
			this.pc.addIceCandidate(new RTCIceCandidate(msg))
		})
	}


	async waitForPakeB() {
		const [m, error] = await this.wait()
		console.log('got pake message b:', m.data)
		this.key = webwormhole.finish(m.data)
		if (this.key == null) {
		this.fail('could not generate key')
			return
		}
		console.log('generated key')
		this.state = 'wait_for_webtc_offer'
	}

	async waitForWebRtcOffer() {
		const [m, error] = await this.wait()
		msg = JSON.parse(webwormhole.open(this.key, m.data));
		if (msg == null) {
			this.fail("bad key");
			this.ws.send(webwormhole.seal(this.key, "bye"));
			this.ws.close();
			return;
		}
		if (msg.type !== "offer") {
			console.log("unexpected message", msg);
			this.fail("unexpected message");
			return;
		}
		console.log("got offer");
		// No intermediate state wait_for_pc_initialize because candidates can
		// staring arriving straight after the offer is sent.
		this.state = "wait_for_candidates";
	}
	
	
	async join() {
		const [m, error] = await wait(this.ws)
		msg = JSON.parse(m.data)
		this.newPeerConnection(msg.iceServers)
		this.resolve1({
			pc: this.pc,
		})
		const msgA = webwormhole.start(this.pass)
		if (msgA == null) {
		this.fail("couldn't generate A's PAKE message")
			return
		}
		console.log('message a:', msgA)
		this.ws.send(msgA)
		this.state = 'wait_for_pake_b'


		await this.waitForPakeB()
		
		await this.promise2
		await this.pc.setRemoteDescription(new RTCSessionDescription(msg));
		const answer = await this.pc.createAnswer();
		console.log("created answer");
		this.ws.send(webwormhole.seal(this.key, JSON.stringify(answer)));
		this.resolve3(webwormhole.fingerprint(this.key));
		this.pc.setLocalDescription(answer);


		
		await this.waitForCandidates()
	}

	onmessage(m) {
		switch (this.state) {
			case "wait_for_pc_initialize":
			case "wait_for_local_offer":
			case "wait_for_local_answer": {
				console.log("unexpected message", m);
				this.fail("unexpected message");
				return;
			}
			case "error":
				return;
		}
	}

	newPeerConnection(iceServers) {
		let normalisedICEServers = [];
		for (let i = 0; i < iceServers.length; i++) {
			normalisedICEServers.push({
				urls: iceServers[i].URLs,
				username: iceServers[i].Username,
				credential: iceServers[i].Credential,
			});
		}
		this.pc = new RTCPeerConnection({
			iceServers: normalisedICEServers,
		});
		this.pc.onicecandidate = (e) => {
			if (e.candidate && e.candidate.candidate !== "") {
				console.log("got local candidate", e.candidate);
				this.ws.send(webwormhole.seal(this.key, JSON.stringify(e.candidate)));
			} else if (!e.candidate) {
				Wormhole.logNAT(this.pc.localDescription.sdp);
			}
		};
	}

	onopen() {
		console.log("websocket session established");
	}

	onerror(e) {
		console.log("websocket session error:", e);
		this.fail("could not connect to signalling server");
	}

	onclose(e) {
		if (e.code === 4000) {
			this.fail("no such slot");
		} else if (e.code === 4001) {
			this.fail("timed out");
		} else if (e.code === 4002) {
			this.fail("could not get slot");
		} else if (e.code === 4003) {
			this.fail("wrong protocol version, must update");
		} else if (e.code === 4004 || e.code === 1001) {
			// Workaround for regression introduced in firefox around version ~78.
			// Usually the websocket connection stays open for the duration of the session, since
			// it doesn't hurt and it make candidate trickling easier. We only do this here out of
			// laziness. The go code has more disciplined websocket lifecycle management.
			// Recent versions of Firefox introduced a bug where websocket connections are killed
			// when a download begins. This would happen after the WebRTC connection is set up
			// so it's not really an error we need to react to.
		} else {
			this.fail(`websocket session closed: ${e.reason} (${e.code})`);
		}
	}

	fail(reason) {
		this.reject1(reason);
		this.reject3(reason);
		this.state = "error";
	}

	// wsserver creates a WebSocket scheme (ws: or wss:) URL from an HTTP one.
	static wsserver(url, slot) {
		const u = new URL(url);
		let protocol = "wss:";
		if (u.protocol === "http:") {
			protocol = "ws:";
		}
		let path = u.pathname + slot;
		if (!path.startsWith("/")) {
			path = `/${path}`;
		}
		return `${protocol}//${u.host}${path}`;
	}

	// logNAT tries to guess the type of NAT based on candidates and log it.
	static logNAT(sdp) {
		let count = 0;
		let host = 0;
		let srflx = 0;
		const portmap = new Map();

		const lines = sdp.replace(/\r/g, "").split("\n");
		for (let i = 0; i < lines.length; i++) {
			if (!lines[i].startsWith("a=candidate:")) {
				continue;
			}
			const parts = lines[i].substring("a=candidate:".length).split(" ");
			const proto = parts[2].toLowerCase();
			const port = parts[5];
			const typ = parts[7];
			if (proto !== "udp") {
				continue;
			}
			count++;
			if (typ === "host") {
				host++;
			} else if (typ === "srflx") {
				srflx++;
				let rport = "";
				for (let j = 8; j < parts.length; j += 2) {
					if (parts[j] === "rport") {
						rport = parts[j + 1];
					}
				}
				if (!portmap.get(rport)) {
					portmap.set(rport, new Set());
				}
				portmap.get(rport).add(port);
			}
		}
		console.log(`local udp candidates: ${count} (host: ${host} stun: ${srflx})`);
		let maxmapping = 0;
		portmap.forEach((v) => {
			if (v.size > maxmapping) {
				maxmapping = v.size;
			}
		});
		if (maxmapping === 0) {
			console.log("nat: ice disabled or stun blocked");
		} else if (maxmapping === 1) {
			console.log("nat: 1:1 port mapping");
		} else if (maxmapping > 1) {
			console.log("nat: 1:n port mapping (bad news?)");
		} else {
			console.log("nat: failed to estimate nat type");
		}
		console.log(
			"for more webrtc troubleshooting try https://test.webrtc.org/ and your browser webrtc logs (about:webrtc or chrome://webrtc-internals/)",
		);
	}

	// WASM loads the WebAssembly part from url.
	static async WASM(url) {
		// Polyfill for Safari WASM streaming.
		if (!WebAssembly.instantiateStreaming) {
			WebAssembly.instantiateStreaming = async (resp, importObject) => {
				const source = await (await resp).arrayBuffer();
				return await WebAssembly.instantiate(source, importObject);
			};
		}
		const go = new Go();
		const wasm = await WebAssembly.instantiateStreaming(
			fetch(url),
			go.importObject,
		);
		go.run(wasm.instance);
	}
}

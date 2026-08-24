/**
 * PNP Highway Patrol Group (HPG) Tactical Dispatcher Console
 * Real-Time Telematics, PTT Voice Engine, CAD Dispatch, WebRTC Video/Audio Calling,
 * and Remote Intercept Overrides.
 */

class DispatcherConsole {
  constructor(config = {}) {
    this.serverUrl = config.serverUrl || window.location.origin;
    this.dispatcherId = config.dispatcherId || "DISPATCH_MAIN";
    this.socket = null;

    // Active State Trackers
    this.selectedUnit = "HPG_GROUP_ALL"; // Default target: Tactical Group Broadcast
    this.activePeerConnections = {};    // Map of unitId -> RTCPeerConnection
    this.mediaRecorders = {};           // PTT MediaRecorder instances
    this.localStream = null;
    this.remoteStreams = {};

    // RTC Configuration (Ice / STUN / TURN Servers for field WebRTC connectivity)
    this.rtcConfig = {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        // { urls: "turn:hpg-turn-server.pnp.gov.ph:3478", username: "hpg_user", credential: "hpg_password" }
      ],
    };

    // Callback Hooks for UI / DOM Integration
    this.onMessageReceived = config.onMessageReceived || null;
    this.onTelemetryReceived = config.onTelemetryReceived || null;
    this.onRemoteStreamAdded = config.onRemoteStreamAdded || null;
    this.onPTTAudioChunk = config.onPTTAudioChunk || null;

    this.init();
  }

  /**
   * Initialize Socket.IO connection and bind tactical system events
   */
  init() {
    this.socket = io(this.serverUrl, {
      query: { unit_id: this.dispatcherId, role: "DISPATCHER" },
    });

    this.socket.on("connect", () => {
      console.log(`[HPG Dispatch] Connected to Command Engine as ${this.dispatcherId}`);
      this.socket.emit("REGISTER_DEVICE", {
        unit_id: this.dispatcherId,
        role: "DISPATCHER",
        agency: "PNP-HPG",
      });
    });

    // Event listeners for tactical messages, PTT audio, and RTC signaling
    this.socket.on("TACTICAL_MESSAGE", (data) => this.handleIncomingMessage(data));
    this.socket.on("PTT_AUDIO_CHUNK", (data) => this.handleIncomingPTT(data));
    this.socket.on("SIGNAL_EXCHANGE", (data) => this.handleSignalingData(data));
    this.socket.on("TELEMETRY_REPORT", (data) => {
      if (this.onTelemetryReceived) this.onTelemetryReceived(data);
    });
  }

  /**
   * Update target recipient for tactical communications ("HPG_GROUP_ALL", "HPG-PATROL-01", etc.)
   */
  setSelectedUnit(unitId) {
    this.selectedUnit = unitId;
    console.log(`[HPG Dispatch] Tactical Target Updated: ${this.selectedUnit}`);
  }

  /* =========================================================================
     1. PUSH-TO-TALK (PTT) HALF-DUPLEX VOICE TRANSMISSION ENGINE
     ========================================================================= */

  /**
   * Key-Down / Hold PTT Key - Start Audio Broadcast
   */
  async startPTTTransmission() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });

      this.mediaRecorders["PTT"] = { recorder: mediaRecorder, stream: stream };

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && this.socket) {
          const reader = new FileReader();
          reader.readAsDataURL(event.data);
          reader.onloadend = () => {
            const base64Audio = reader.result.split(",")[1];
            this.socket.emit("PTT_AUDIO_CHUNK", {
              sender_id: this.dispatcherId,
              target_unit: this.selectedUnit,
              priority: 0, // Priority 0: Command Dispatcher Override (Interrupts normal traffic)
              audio_payload_base64: base64Audio,
              timestamp: Date.now(),
            });
          };
        }
      };

      // Emit audio chunks every 100ms for real-time low-latency PTT
      mediaRecorder.start(100);
      console.log(`[HPG PTT] Transmitting to Target Unit/Group: ${this.selectedUnit}...`);
    } catch (err) {
      console.error("[HPG PTT] Microhpone Capture Error:", err);
    }
  }

  /**
   * Release PTT Key - End Voice Broadcast
   */
  stopPTTTransmission() {
    if (this.mediaRecorders["PTT"]) {
      const { recorder, stream } = this.mediaRecorders["PTT"];
      recorder.stop();
      stream.getTracks().forEach((track) => track.stop());
      delete this.mediaRecorders["PTT"];
      console.log("[HPG PTT] Radio Transmission Terminated.");
    }
  }

  /**
   * Handle and play incoming PTT audio streams from HPG Patrol Units
   */
  handleIncomingPTT(data) {
    if (data.sender_id === this.dispatcherId) return; // Prevent local audio feedback loops

    const audioUrl = `data:audio/webm;codecs=opus;base64,${data.audio_payload_base64}`;
    const audio = new Audio(audioUrl);
    audio.play().catch((e) => console.error("[HPG PTT Playback Error]", e));

    if (this.onPTTAudioChunk) this.onPTTAudioChunk(data);
  }

  /* =========================================================================
     2. CAD DISPATCH, TEXT MESSAGING & MEDIA ATTACHMENTS
     ========================================================================= */

  /**
   * Dispatch text instruction or CAD incident assignment to target unit
   */
  sendTextMessage(text, taskPayload = null) {
    const payload = {
      message_id: "hpg_msg_" + Date.now(),
      sender: this.dispatcherId,
      recipient: this.selectedUnit,
      timestamp: Date.now(),
      text: text,
      task: taskPayload, // Optional JSON object containing target GPS target coordinates & incident data
    };

    this.socket.emit("TACTICAL_MESSAGE", payload);
    return payload;
  }

  /**
   * Attach and upload media evidence or situation photos (Images, Videos, Voice Audio)
   */
  sendMediaAttachment(file, fileType = "IMAGE") {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const payload = {
        message_id: "hpg_media_" + Date.now(),
        sender: this.dispatcherId,
        recipient: this.selectedUnit,
        timestamp: Date.now(),
        type: fileType, // "IMAGE", "VIDEO", "AUDIO"
        file_name: file.name,
        file_data_base64: reader.result,
      };
      this.socket.emit("TACTICAL_MESSAGE", payload);
    };
  }

  handleIncomingMessage(data) {
    console.log("[HPG Comms Received]", data);
    if (this.onMessageReceived) this.onMessageReceived(data);
  }

  /* =========================================================================
     3. WEBRTC LIVE VIDEO & DUPLEX AUDIO CALLING
     ========================================================================= */

  /**
   * Initiate full WebRTC Video/Audio Call to an active patrol unit
   */
  async startCall(targetUnitId, includeVideo = true) {
    console.log(`[HPG RTC] Establishing live video feed with ${targetUnitId}`);
    const peerConnection = this.createPeerConnection(targetUnitId);

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: includeVideo,
    });

    this.localStream.getTracks().forEach((track) => {
      peerConnection.addTrack(track, this.localStream);
    });

    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    this.socket.emit("SIGNAL_EXCHANGE", {
      target_id: targetUnitId,
      sender_id: this.dispatcherId,
      signalData: { type: "offer", sdp: offer.sdp },
    });
  }

  /**
   * Process WebRTC SDP Offers, Answers, and ICE Candidates
   */
  async handleSignalingData(data) {
    const { sender_id, signalData } = data;
    let pc = this.activePeerConnections[sender_id];

    if (!pc) {
      pc = this.createPeerConnection(sender_id);
    }

    if (signalData.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(signalData));
      
      this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream));

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.socket.emit("SIGNAL_EXCHANGE", {
        target_id: sender_id,
        sender_id: this.dispatcherId,
        signalData: { type: "answer", sdp: answer.sdp },
      });
    } else if (signalData.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(signalData));
    } else if (signalData.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
    }
  }

  createPeerConnection(targetUnitId) {
    const pc = new RTCPeerConnection(this.rtcConfig);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit("SIGNAL_EXCHANGE", {
          target_id: targetUnitId,
          sender_id: this.dispatcherId,
          signalData: { candidate: event.candidate },
        });
      }
    };

    pc.ontrack = (event) => {
      console.log(`[HPG RTC] Incoming stream track from unit ${targetUnitId}`);
      this.remoteStreams[targetUnitId] = event.streams[0];
      if (this.onRemoteStreamAdded) {
        this.onRemoteStreamAdded(targetUnitId, event.streams[0]);
      }
    };

    this.activePeerConnections[targetUnitId] = pc;
    return pc;
  }

  endCall(targetUnitId) {
    if (this.activePeerConnections[targetUnitId]) {
      this.activePeerConnections[targetUnitId].close();
      delete this.activePeerConnections[targetUnitId];
      console.log(`[HPG RTC] Connection with ${targetUnitId} closed.`);
    }
  }

  /* =========================================================================
     4. TACTICAL OVERRIDES (IMMOBILIZER, SIREN ALARM, CAM & MIC OVERRIDE)
     ========================================================================= */

  /**
   * Issue high-priority command override to patrol bike device
   * @param {string} commandType - "FORCE_POLICE_SIREN", "DISABLE_VEHICLE_IMMOBILIZER", "ENABLE_VEHICLE_IMMOBILIZER", "FORCE_CAM_STREAM", "FORCE_MIC_STREAM"
   */
  executeRemoteOverride(commandType, targetUnitId = null) {
    const target = targetUnitId || this.selectedUnit;
    if (target === "HPG_GROUP_ALL" && commandType !== "FORCE_POLICE_SIREN") {
      console.warn("[HPG Override] Stream and Engine overrides must specify an individual patrol unit.");
      return;
    }

    const payload = {
      command_id: "hpg_cmd_" + Date.now(),
      target_unit: target,
      issuer: this.dispatcherId,
      action: commandType,
      timestamp: Date.now(),
    };

    this.socket.emit("DISPATCH_COMMAND", payload);
    console.log(`[HPG Override Executed] Action: ${commandType} -> Target Unit: ${target}`);
  }
}
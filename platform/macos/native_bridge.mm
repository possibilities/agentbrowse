#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <LiveKitWebRTC/LiveKitWebRTC.h>

#include "kernel_live_view_native.h"
#include <stdio.h>

static NSString *KLString(const uint8_t *bytes, size_t len) {
  if (bytes == nullptr) return @"";
  return [[NSString alloc] initWithBytes:bytes length:len encoding:NSUTF8StringEncoding] ?: @"";
}

static void KLBytes(NSString *value, void (^body)(const uint8_t *, size_t)) {
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
  body(static_cast<const uint8_t *>(data.bytes), data.length);
}

@interface KLInputView : NSView
@property(nonatomic, assign) KLAppKitCallbacks callbacks;
@property(nonatomic, strong) LKRTCMTLVideoView *videoView;
@property(nonatomic, strong) NSTextField *statusLabel;
@property(nonatomic, strong) NSTrackingArea *trackingArea;
@property(nonatomic, strong) NSCursor *transparentCursor;
@property(nonatomic, assign) CGSize videoSize;
@end

@implementation KLInputView

- (instancetype)initWithFrame:(NSRect)frame callbacks:(KLAppKitCallbacks)callbacks {
  self = [super initWithFrame:frame];
  if (!self) return nil;
  _callbacks = callbacks;
  self.wantsLayer = YES;
  self.layer.backgroundColor = NSColor.blackColor.CGColor;

  _videoView = [[LKRTCMTLVideoView alloc] initWithFrame:self.bounds];
  _videoView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [self addSubview:_videoView];

  NSImage *transparentImage = [[NSImage alloc] initWithSize:NSMakeSize(1, 1)];
  _transparentCursor = [[NSCursor alloc] initWithImage:transparentImage
                                              hotSpot:NSZeroPoint];

  _statusLabel = [NSTextField labelWithString:@"Connecting…"];
  _statusLabel.translatesAutoresizingMaskIntoConstraints = NO;
  _statusLabel.textColor = NSColor.whiteColor;
  _statusLabel.font = [NSFont monospacedSystemFontOfSize:12 weight:NSFontWeightMedium];
  _statusLabel.wantsLayer = YES;
  _statusLabel.layer.backgroundColor = [NSColor colorWithWhite:0 alpha:0.65].CGColor;
  _statusLabel.layer.cornerRadius = 5;
  [self addSubview:_statusLabel];
  [NSLayoutConstraint activateConstraints:@[
    [_statusLabel.leadingAnchor constraintEqualToAnchor:self.leadingAnchor constant:12],
    [_statusLabel.topAnchor constraintEqualToAnchor:self.topAnchor constant:12],
  ]];
  return self;
}

- (BOOL)acceptsFirstResponder { return YES; }
- (NSView *)hitTest:(NSPoint)point {
  // The Metal video renderer is presentation-only. Keep it out of AppKit's
  // responder hit-testing so pointer clicks and keyboard focus stay on the
  // frontend adapter rather than disappearing into the renderer subview.
  return NSPointInRect(point, self.bounds) ? self : nil;
}
- (NSRect)fittedVideoRect {
  if (_videoSize.width <= 0 || _videoSize.height <= 0 ||
      self.bounds.size.width <= 0 || self.bounds.size.height <= 0) {
    return NSZeroRect;
  }
  CGFloat scale = MIN(self.bounds.size.width / _videoSize.width,
                      self.bounds.size.height / _videoSize.height);
  NSSize fitted = NSMakeSize(_videoSize.width * scale, _videoSize.height * scale);
  return NSMakeRect(NSMidX(self.bounds) - fitted.width / 2,
                    NSMidY(self.bounds) - fitted.height / 2,
                    fitted.width, fitted.height);
}
- (void)setVideoSize:(CGSize)videoSize {
  _videoSize = videoSize;
  [self.window invalidateCursorRectsForView:self];
}
- (void)resetCursorRects {
  [super resetCursorRects];
  NSRect fitted = [self fittedVideoRect];
  if (!NSIsEmptyRect(fitted)) [self addCursorRect:fitted cursor:_transparentCursor];
}
- (BOOL)becomeFirstResponder {
  if (_callbacks.on_focus) _callbacks.on_focus(_callbacks.context, true);
  return YES;
}
- (BOOL)resignFirstResponder {
  if (_callbacks.on_focus) _callbacks.on_focus(_callbacks.context, false);
  return YES;
}

- (void)updateTrackingAreas {
  if (_trackingArea) [self removeTrackingArea:_trackingArea];
  _trackingArea = [[NSTrackingArea alloc]
      initWithRect:self.bounds
           options:NSTrackingMouseMoved | NSTrackingActiveInKeyWindow |
                   NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:_trackingArea];
  [super updateTrackingAreas];
}

- (void)sendPointer:(NSEvent *)event kind:(uint8_t)kind button:(uint8_t)button {
  if (!_callbacks.on_pointer) return;
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  _callbacks.on_pointer(_callbacks.context, point.x, point.y,
                        self.bounds.size.width, self.bounds.size.height, kind,
                        button, 0, 0,
                        (event.modifierFlags & NSEventModifierFlagControl) != 0);
}

- (void)mouseMoved:(NSEvent *)event { [self sendPointer:event kind:0 button:0]; }
- (void)mouseDragged:(NSEvent *)event { [self sendPointer:event kind:0 button:0]; }
- (void)rightMouseDragged:(NSEvent *)event { [self sendPointer:event kind:0 button:2]; }
- (void)otherMouseDragged:(NSEvent *)event { [self sendPointer:event kind:0 button:1]; }
- (void)mouseDown:(NSEvent *)event {
  [self.window makeFirstResponder:self];
  [self sendPointer:event kind:1 button:0];
}
- (void)mouseUp:(NSEvent *)event { [self sendPointer:event kind:2 button:0]; }
- (void)rightMouseDown:(NSEvent *)event {
  [self.window makeFirstResponder:self];
  [self sendPointer:event kind:1 button:2];
}
- (void)rightMouseUp:(NSEvent *)event { [self sendPointer:event kind:2 button:2]; }
- (void)otherMouseDown:(NSEvent *)event {
  [self.window makeFirstResponder:self];
  [self sendPointer:event kind:1 button:1];
}
- (void)otherMouseUp:(NSEvent *)event { [self sendPointer:event kind:2 button:1]; }
- (void)scrollWheel:(NSEvent *)event {
  if (!_callbacks.on_pointer) return;
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  _callbacks.on_pointer(
      _callbacks.context, point.x, point.y, self.bounds.size.width,
      self.bounds.size.height, event.hasPreciseScrollingDeltas ? 3 : 4, 0,
      event.scrollingDeltaX,
      event.scrollingDeltaY,
      (event.modifierFlags & NSEventModifierFlagControl) != 0);
}

- (void)sendKey:(NSEvent *)event pressed:(BOOL)pressed {
  if (!_callbacks.on_key) return;
  NSString *characters = event.charactersIgnoringModifiers ?: @"";
  NSData *data = [characters dataUsingEncoding:NSUTF8StringEncoding] ?: [NSData data];
  _callbacks.on_key(_callbacks.context, event.keyCode,
                    static_cast<uint64_t>(event.modifierFlags), pressed,
                    event.isARepeat,
                    static_cast<const uint8_t *>(data.bytes), data.length);
}

- (void)keyDown:(NSEvent *)event { [self sendKey:event pressed:YES]; }
- (void)keyUp:(NSEvent *)event { [self sendKey:event pressed:NO]; }
- (void)flagsChanged:(NSEvent *)event {
  NSEventModifierFlags mask = 0;
  switch (event.keyCode) {
    case 54: case 55: mask = NSEventModifierFlagCommand; break;
    case 56: case 60: mask = NSEventModifierFlagShift; break;
    case 57: mask = NSEventModifierFlagCapsLock; break;
    case 58: case 61: mask = NSEventModifierFlagOption; break;
    case 59: case 62: mask = NSEventModifierFlagControl; break;
    default: break;
  }
  [self sendKey:event pressed:(event.modifierFlags & mask) != 0];
}

- (BOOL)performKeyEquivalent:(NSEvent *)event {
  if ((event.modifierFlags & NSEventModifierFlagCommand) != 0 &&
      [event.charactersIgnoringModifiers.lowercaseString isEqualToString:@"v"]) {
    // Command-V is owned locally. AppKit may already have delivered the
    // Command flagsChanged event, so clear either Meta keysym before the
    // delayed guest Control-V sequence.
    if (_callbacks.on_key) {
      static const uint8_t empty = 0;
      _callbacks.on_key(_callbacks.context, 55, 0, false, false, &empty, 0);
      _callbacks.on_key(_callbacks.context, 54, 0, false, false, &empty, 0);
    }
    NSString *text = [NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString];
    if (text && _callbacks.on_paste) {
      NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
      _callbacks.on_paste(_callbacks.context,
                          static_cast<const uint8_t *>(data.bytes), data.length);
    }
    return YES;
  }
  return [super performKeyEquivalent:event];
}

@end

@interface KLFrameSink : NSObject <LKRTCVideoRenderer>
@property(nonatomic, assign) KLNativeCallbacks callbacks;
@property(nonatomic, strong) NSLock *callbackLock;
@property(nonatomic, assign) BOOL enabled;
@end

@implementation KLFrameSink
- (void)setSize:(CGSize)size { (void)size; }
- (void)renderFrame:(LKRTCVideoFrame *)frame {
  if (!frame) return;
  [_callbackLock lock];
  if (!_enabled || !_callbacks.on_frame) {
    [_callbackLock unlock];
    return;
  }
  id<LKRTCI420Buffer> buffer = [frame.buffer toI420];
  _callbacks.on_frame(_callbacks.context, buffer.width, buffer.height,
                      static_cast<uint16_t>(frame.rotation),
                      frame.timeStampNs / 1000, buffer.dataY, buffer.strideY,
                      buffer.dataU, buffer.strideU, buffer.dataV,
                      buffer.strideV);
  [_callbackLock unlock];
}
@end

@interface KLNativeSession : NSObject <
    NSApplicationDelegate, NSWindowDelegate, NSURLSessionWebSocketDelegate,
    LKRTCPeerConnectionDelegate, LKRTCDataChannelDelegate,
    LKRTCVideoViewDelegate>
@property(nonatomic, assign) KLNativeCallbacks callbacks;
@property(nonatomic, assign) KLAppKitCallbacks appKitCallbacks;
@property(nonatomic, strong) NSCondition *callbackCondition;
@property(nonatomic, assign) BOOL callbacksEnabled;
@property(nonatomic, assign) NSUInteger callbacksInFlight;
@property(nonatomic, copy) NSString *windowTitle;
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) KLInputView *inputView;
// The transport object graph and reconnect flags are accessed only while
// synchronized on this session. NSURLSession and WebRTC use different worker
// queues, so property-level atomicity would not make a reset coherent.
@property(nonatomic, strong) NSURLSession *urlSession;
@property(nonatomic, strong) NSURLSessionWebSocketTask *webSocket;
@property(nonatomic, strong) dispatch_source_t heartbeat;
@property(nonatomic, strong) LKRTCPeerConnectionFactory *factory;
@property(nonatomic, strong) LKRTCPeerConnection *peer;
@property(nonatomic, strong) LKRTCDataChannel *dataChannel;
@property(nonatomic, strong) LKRTCVideoTrack *videoTrack;
@property(nonatomic, strong) KLFrameSink *frameSink;
@property(nonatomic, strong) NSTimer *statusTimer;
@property(nonatomic, assign) BOOL closing;
@property(nonatomic, assign) BOOL reconnectScheduled;
@end

@implementation KLNativeSession

- (instancetype)initWithCallbacks:(KLNativeCallbacks)callbacks {
  self = [super init];
  if (!self) return nil;
  _callbacks = callbacks;
  _callbackCondition = [NSCondition new];
  _callbacksEnabled = YES;
  _frameSink = [KLFrameSink new];
  _frameSink.callbacks = callbacks;
  _frameSink.callbackLock = [NSLock new];
  _frameSink.enabled = YES;
  return self;
}

- (BOOL)beginCallback {
  [self.callbackCondition lock];
  if (!self.callbacksEnabled) {
    [self.callbackCondition unlock];
    return NO;
  }
  self.callbacksInFlight += 1;
  [self.callbackCondition unlock];
  return YES;
}

- (void)endCallback {
  [self.callbackCondition lock];
  self.callbacksInFlight -= 1;
  if (self.callbacksInFlight == 0) [self.callbackCondition broadcast];
  [self.callbackCondition unlock];
}

- (void)disableCallbacks {
  [self.callbackCondition lock];
  self.callbacksEnabled = NO;
  while (self.callbacksInFlight != 0) [self.callbackCondition wait];
  [self.callbackCondition unlock];
}

- (void)reportError:(NSString *)category {
  if (!_callbacks.on_error || ![self beginCallback]) return;
  KLBytes(category, ^(const uint8_t *bytes, size_t len) {
    self.callbacks.on_error(self.callbacks.context, bytes, len);
  });
  [self endCallback];
}

- (void)emitState:(KLNativeState)state {
  if (!_callbacks.on_state || ![self beginCallback]) return;
  _callbacks.on_state(_callbacks.context, state);
  [self endCallback];
}

- (BOOL)createWindowWithCallbacks:(KLAppKitCallbacks)callbacks
                             title:(NSString *)title {
  if (self.window) return NO;
  self.appKitCallbacks = callbacks;
  self.windowTitle = title.length ? title : @"Kernel Live View";
  [NSApplication sharedApplication];
  NSApp.delegate = self;
  [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];

  NSMenu *menuBar = [NSMenu new];
  NSMenuItem *appMenuItem = [NSMenuItem new];
  [menuBar addItem:appMenuItem];
  NSMenu *appMenu = [NSMenu new];
  NSString *quitTitle = [@"Quit " stringByAppendingString:self.windowTitle];
  [appMenu addItemWithTitle:quitTitle action:@selector(terminate:) keyEquivalent:@"q"];
  appMenuItem.submenu = appMenu;
  NSApp.mainMenu = menuBar;

  NSRect frame = NSMakeRect(0, 0, 1280, 760);
  self.window = [[NSWindow alloc]
      initWithContentRect:frame
                styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                          NSWindowStyleMaskMiniaturizable |
                          NSWindowStyleMaskResizable
                  backing:NSBackingStoreBuffered
                    defer:NO];
  self.window.title = self.windowTitle;
  self.window.delegate = self;
  self.window.releasedWhenClosed = NO;
  self.window.acceptsMouseMovedEvents = YES;
  self.inputView = [[KLInputView alloc] initWithFrame:frame callbacks:self.appKitCallbacks];
  self.inputView.videoView.delegate = self;
  self.window.contentView = self.inputView;
  [self.window center];
  __weak KLNativeSession *weakSelf = self;
  self.statusTimer = [NSTimer scheduledTimerWithTimeInterval:0.1
                                                     repeats:YES
                                                       block:^(NSTimer *timer) {
    (void)timer;
    KLNativeSession *strongSelf = weakSelf;
    if (!strongSelf || !strongSelf.appKitCallbacks.copy_status) return;
    uint8_t buffer[256];
    uint32_t length = strongSelf.appKitCallbacks.copy_status(
        strongSelf.appKitCallbacks.context, buffer, sizeof(buffer));
    if (length > sizeof(buffer)) length = sizeof(buffer);
    strongSelf.inputView.statusLabel.stringValue = KLString(buffer, length);
  }];
  return YES;
}

- (void)connectBaseURL:(NSString *)baseURL
              username:(NSString *)username
              password:(NSString *)password {
  @synchronized (self) {
    if (self.closing) return;
    NSURLComponents *components = [NSURLComponents componentsWithString:baseURL];
    if (!components || !components.scheme || !components.host) {
      [self reportError:@"invalid connection URL"];
      return;
    }
    components.scheme = [components.scheme.lowercaseString isEqualToString:@"https"] ? @"wss" : @"ws";
    NSString *path = components.path ?: @"";
    if ([path hasSuffix:@"/"]) path = [path substringToIndex:path.length - 1];
    components.path = [path stringByAppendingString:@"/ws"];
    NSMutableArray<NSURLQueryItem *> *items = [NSMutableArray arrayWithArray:components.queryItems ?: @[]];
    [items addObject:[NSURLQueryItem queryItemWithName:@"password" value:password]];
    [items addObject:[NSURLQueryItem queryItemWithName:@"username" value:username]];
    components.queryItems = items;
    NSURL *url = components.URL;
    if (!url) {
      [self reportError:@"invalid websocket URL"];
      return;
    }

    NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    configuration.timeoutIntervalForRequest = 15;
    self.urlSession = [NSURLSession sessionWithConfiguration:configuration delegate:self delegateQueue:nil];
    self.webSocket = [self.urlSession webSocketTaskWithURL:url];
    [self.webSocket resume];
  }
}

- (void)receiveNextMessage {
  @synchronized (self) {
    if (self.closing || !self.webSocket) return;
    NSURLSessionWebSocketTask *task = self.webSocket;
    __weak KLNativeSession *weakSelf = self;
    [task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
      KLNativeSession *strongSelf = weakSelf;
      if (!strongSelf) return;
      @synchronized (strongSelf) {
        if (strongSelf.closing || task != strongSelf.webSocket) return;
        if (error) {
          [strongSelf reportError:@"websocket receive failed"];
          [strongSelf emitState:KL_NATIVE_WS_CLOSED];
          return;
        }
        NSString *text = message.string;
        if (text && strongSelf.callbacks.on_websocket_message &&
            [strongSelf beginCallback]) {
          KLBytes(text, ^(const uint8_t *bytes, size_t len) {
            strongSelf.callbacks.on_websocket_message(strongSelf.callbacks.context, bytes, len);
          });
          [strongSelf endCallback];
        }
        [strongSelf receiveNextMessage];
      }
    }];
  }
}

- (BOOL)sendWebSocketBytes:(const uint8_t *)bytes length:(size_t)len {
  @synchronized (self) {
    if (!self.webSocket || self.closing) return NO;
    NSURLSessionWebSocketTask *task = self.webSocket;
    NSString *text = KLString(bytes, len);
    NSURLSessionWebSocketMessage *message = [[NSURLSessionWebSocketMessage alloc] initWithString:text];
    [task sendMessage:message completionHandler:^(NSError *error) {
      @synchronized (self) {
        if (error && !self.closing && task == self.webSocket) {
          [self reportError:@"websocket send failed"];
          [self emitState:KL_NATIVE_WS_CLOSED];
        }
      }
    }];
    return YES;
  }
}

- (void)createPeerWithIceJSON:(NSString *)iceJSON lite:(BOOL)lite {
  @synchronized (self) {
    if (self.closing || self.peer) return;
    LKRTCDefaultVideoEncoderFactory *encoder = [LKRTCDefaultVideoEncoderFactory new];
    LKRTCDefaultVideoDecoderFactory *decoder = [LKRTCDefaultVideoDecoderFactory new];
    self.factory = [[LKRTCPeerConnectionFactory alloc] initWithEncoderFactory:encoder decoderFactory:decoder];

    LKRTCConfiguration *configuration = [LKRTCConfiguration new];
    configuration.sdpSemantics = LKRTCSdpSemanticsUnifiedPlan;
    NSMutableArray<LKRTCIceServer *> *servers = [NSMutableArray new];
    if (!lite) {
      NSData *data = [iceJSON dataUsingEncoding:NSUTF8StringEncoding];
      NSArray *entries = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
      if ([entries isKindOfClass:NSArray.class]) {
        for (NSDictionary *entry in entries) {
          id urlsValue = entry[@"urls"];
          NSArray<NSString *> *urls = [urlsValue isKindOfClass:NSString.class] ? @[urlsValue] : urlsValue;
          if (![urls isKindOfClass:NSArray.class] || urls.count == 0) continue;
          NSString *username = [entry[@"username"] isKindOfClass:NSString.class] ? entry[@"username"] : nil;
          NSString *credential = [entry[@"credential"] isKindOfClass:NSString.class] ? entry[@"credential"] : nil;
          [servers addObject:[[LKRTCIceServer alloc] initWithURLStrings:urls username:username credential:credential]];
        }
      }
    }
    configuration.iceServers = servers;
    NSDictionary *mandatory = @{
      @"OfferToReceiveVideo" : @"true",
      @"OfferToReceiveAudio" : @"false",
    };
    LKRTCMediaConstraints *constraints = [[LKRTCMediaConstraints alloc] initWithMandatoryConstraints:mandatory optionalConstraints:nil];
    self.peer = [self.factory peerConnectionWithConfiguration:configuration constraints:constraints delegate:self];
    if (!self.peer) {
      [self reportError:@"peer creation failed"];
      return;
    }
    LKRTCDataChannelConfiguration *dataConfiguration = [LKRTCDataChannelConfiguration new];
    self.dataChannel = [self.peer dataChannelForLabel:@"data" configuration:dataConfiguration];
    self.dataChannel.delegate = self;
    fprintf(stderr, "native data channel: created label=%s id=%d ordered=%s\n",
            self.dataChannel.label.UTF8String, self.dataChannel.channelId,
            self.dataChannel.isOrdered ? "true" : "false");
    [self emitState:KL_NATIVE_PEER_CONNECTING];
  }
}

- (void)setRemoteAnswer:(BOOL)answer sdp:(NSString *)sdp {
  @synchronized (self) {
    if (!self.peer) {
      [self reportError:@"remote description arrived before peer creation"];
      return;
    }
    LKRTCSessionDescription *description = [[LKRTCSessionDescription alloc]
        initWithType:answer ? LKRTCSdpTypeAnswer : LKRTCSdpTypeOffer
                 sdp:sdp];
    LKRTCPeerConnection *peer = self.peer;
    __weak KLNativeSession *weakSelf = self;
    __weak LKRTCPeerConnection *weakPeer = peer;
    [peer setRemoteDescription:description completionHandler:^(NSError *error) {
      KLNativeSession *remoteSelf = weakSelf;
      LKRTCPeerConnection *remotePeer = weakPeer;
      if (!remoteSelf || !remotePeer) return;
      @synchronized (remoteSelf) {
        if (remoteSelf.closing || remotePeer != remoteSelf.peer) return;
        if (error) {
          [remoteSelf reportError:@"set remote description failed"];
          return;
        }
        if (answer) return;
        LKRTCMediaConstraints *constraints = [[LKRTCMediaConstraints alloc] initWithMandatoryConstraints:nil optionalConstraints:nil];
        [remotePeer answerForConstraints:constraints completionHandler:^(LKRTCSessionDescription *local, NSError *answerError) {
          KLNativeSession *answerSelf = weakSelf;
          LKRTCPeerConnection *answerPeer = weakPeer;
          if (!answerSelf || !answerPeer) return;
          @synchronized (answerSelf) {
            if (answerSelf.closing || answerPeer != answerSelf.peer) return;
            if (answerError || !local) {
              [answerSelf reportError:@"create answer failed"];
              return;
            }
            [answerPeer setLocalDescription:local completionHandler:^(NSError *localError) {
              KLNativeSession *localSelf = weakSelf;
              LKRTCPeerConnection *localPeer = weakPeer;
              if (!localSelf || !localPeer) return;
              @synchronized (localSelf) {
                if (localSelf.closing || localPeer != localSelf.peer) return;
                if (localError) {
                  [localSelf reportError:@"set local description failed"];
                  return;
                }
                if (localSelf.callbacks.on_local_description &&
                    [localSelf beginCallback]) {
                  KLBytes(local.sdp, ^(const uint8_t *bytes, size_t len) {
                    localSelf.callbacks.on_local_description(localSelf.callbacks.context, true, bytes, len);
                  });
                  [localSelf endCallback];
                }
              }
            }];
          }
        }];
      }
    }];
  }
}

- (void)addCandidateJSON:(NSString *)candidateJSON {
  @synchronized (self) {
    if (!self.peer) return;
    NSData *data = [candidateJSON dataUsingEncoding:NSUTF8StringEncoding];
    NSDictionary *value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![value isKindOfClass:NSDictionary.class]) return;
    NSString *candidate = [value[@"candidate"] isKindOfClass:NSString.class] ? value[@"candidate"] : nil;
    NSString *mid = [value[@"sdpMid"] isKindOfClass:NSString.class] ? value[@"sdpMid"] : nil;
    NSNumber *line = [value[@"sdpMLineIndex"] isKindOfClass:NSNumber.class] ? value[@"sdpMLineIndex"] : @0;
    if (!candidate) return;
    LKRTCIceCandidate *ice = [[LKRTCIceCandidate alloc] initWithSdp:candidate sdpMLineIndex:line.intValue sdpMid:mid];
    LKRTCPeerConnection *peer = self.peer;
    __weak KLNativeSession *weakSelf = self;
    __weak LKRTCPeerConnection *weakPeer = peer;
    [peer addIceCandidate:ice completionHandler:^(NSError *error) {
      KLNativeSession *strongSelf = weakSelf;
      LKRTCPeerConnection *strongPeer = weakPeer;
      if (!strongSelf || !strongPeer) return;
      @synchronized (strongSelf) {
        if (error && !strongSelf.closing && strongPeer == strongSelf.peer) {
          [strongSelf reportError:@"add ICE candidate failed"];
        }
      }
    }];
  }
}

- (void)resetTransport {
  @synchronized (self) {
    if (self.heartbeat) dispatch_source_cancel(self.heartbeat);
    self.heartbeat = nil;
    [self.frameSink.callbackLock lock];
    self.frameSink.enabled = NO;
    [self.frameSink.callbackLock unlock];
    if (self.videoTrack) {
      [self.videoTrack removeRenderer:self.frameSink];
      if (self.inputView) [self.videoTrack removeRenderer:self.inputView.videoView];
    }
    self.videoTrack = nil;
    self.dataChannel.delegate = nil;
    [self.dataChannel close];
    self.dataChannel = nil;
    self.peer.delegate = nil;
    [self.peer close];
    self.peer = nil;
    [self.webSocket cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
    self.webSocket = nil;
    [self.urlSession invalidateAndCancel];
    self.urlSession = nil;
    self.factory = nil;
  }
}

- (void)closeNative {
  @synchronized (self) {
    if (self.closing) return;
    self.closing = YES;
    [self.statusTimer invalidate];
    self.statusTimer = nil;
    [self resetTransport];
  }
}

- (void)scheduleReconnectAfter:(uint32_t)delayMs {
  dispatch_queue_t reconnectQueue;
  @synchronized (self) {
    if (self.closing || self.reconnectScheduled) return;
    self.reconnectScheduled = YES;
    // Keep AppKit renderer detach/attach work on its main queue. Headless
    // sessions cannot depend on an NSApplication run loop, so they reconnect
    // on a utility-independent global queue instead.
    reconnectQueue = self.inputView ? dispatch_get_main_queue()
                                    : dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0);
  }
  dispatch_async(reconnectQueue, ^{
    @synchronized (self) {
      if (self.closing) return;
      [self resetTransport];
    }
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,
                                 static_cast<int64_t>(delayMs) * NSEC_PER_MSEC),
                   reconnectQueue, ^{
      @synchronized (self) {
        if (self.closing) return;
        self.reconnectScheduled = NO;
        [self.frameSink.callbackLock lock];
        self.frameSink.enabled = YES;
        [self.frameSink.callbackLock unlock];
        [self emitState:KL_NATIVE_RECONNECT_READY];
      }
    });
  });
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  (void)notification;
  if (!self.window) return;
  [self.window makeKeyAndOrderFront:nil];
  [self.window makeFirstResponder:self.inputView];
  [NSApp activateIgnoringOtherApps:YES];
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  (void)sender;
  return YES;
}
- (void)applicationWillTerminate:(NSNotification *)notification {
  (void)notification;
  if (_appKitCallbacks.on_close) _appKitCallbacks.on_close(_appKitCallbacks.context);
}
- (void)windowDidResignKey:(NSNotification *)notification {
  (void)notification;
  if (_appKitCallbacks.on_focus) _appKitCallbacks.on_focus(_appKitCallbacks.context, false);
}
- (void)windowWillClose:(NSNotification *)notification {
  (void)notification;
  if (_appKitCallbacks.on_close) _appKitCallbacks.on_close(_appKitCallbacks.context);
}

- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask didOpenWithProtocol:(NSString *)protocol {
  (void)session; (void)protocol;
  @synchronized (self) {
    if (self.closing || webSocketTask != self.webSocket) return;
    [self emitState:KL_NATIVE_WS_OPEN];
    [self receiveNextMessage];
  }
}
- (void)URLSession:(NSURLSession *)session webSocketTask:(NSURLSessionWebSocketTask *)webSocketTask didCloseWithCode:(NSURLSessionWebSocketCloseCode)closeCode reason:(NSData *)reason {
  (void)session; (void)closeCode; (void)reason;
  @synchronized (self) {
    if (!self.closing && webSocketTask == self.webSocket) [self emitState:KL_NATIVE_WS_CLOSED];
  }
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  (void)session;
  @synchronized (self) {
    if (!error || self.closing || task != self.webSocket) return;
    [self emitState:KL_NATIVE_WS_CLOSED];
  }
}

- (void)peerConnection:(LKRTCPeerConnection *)peerConnection didChangeSignalingState:(LKRTCSignalingState)stateChanged { (void)peerConnection; (void)stateChanged; }
- (void)peerConnection:(LKRTCPeerConnection *)peerConnection didAddStream:(LKRTCMediaStream *)stream { (void)peerConnection; (void)stream; }
- (void)peerConnection:(LKRTCPeerConnection *)peerConnection didRemoveStream:(LKRTCMediaStream *)stream { (void)peerConnection; (void)stream; }
- (void)peerConnectionShouldNegotiate:(LKRTCPeerConnection *)peerConnection { (void)peerConnection; }
- (void)peerConnection:(LKRTCPeerConnection *)peerConnection didChangeIceConnectionState:(LKRTCIceConnectionState)newState {
  @synchronized (self) {
    if (self.closing || peerConnection != self.peer) return;
    switch (newState) {
      case LKRTCIceConnectionStateConnected:
      case LKRTCIceConnectionStateCompleted: [self emitState:KL_NATIVE_PEER_CONNECTED]; break;
      case LKRTCIceConnectionStateDisconnected: [self emitState:KL_NATIVE_PEER_DISCONNECTED]; break;
      case LKRTCIceConnectionStateFailed:
      case LKRTCIceConnectionStateClosed: [self emitState:KL_NATIVE_PEER_FAILED]; break;
      default: break;
    }
  }
}
- (void)peerConnection:(LKRTCPeerConnection *)peerConnection didChangeIceGatheringState:(LKRTCIceGatheringState)newState { (void)peerConnection; (void)newState; }
- (void)peerConnection:(LKRTCPeerConnection *)peerConnection didGenerateIceCandidate:(LKRTCIceCandidate *)candidate {
  @synchronized (self) {
    if (self.closing || peerConnection != self.peer) return;
    if (!_callbacks.on_local_candidate || ![self beginCallback]) return;
    KLBytes(candidate.sdp, ^(const uint8_t *sdp, size_t sdpLen) {
      KLBytes(candidate.sdpMid ?: @"", ^(const uint8_t *mid, size_t midLen) {
        self.callbacks.on_local_candidate(self.callbacks.context, sdp, sdpLen, mid,
                                          midLen, candidate.sdpMLineIndex);
      });
    });
    [self endCallback];
  }
}
- (void)peerConnection:(LKRTCPeerConnection *)peerConnection didRemoveIceCandidates:(NSArray<LKRTCIceCandidate *> *)candidates { (void)peerConnection; (void)candidates; }
- (void)peerConnection:(LKRTCPeerConnection *)peerConnection didOpenDataChannel:(LKRTCDataChannel *)dataChannel {
  @synchronized (self) {
    if (self.closing || peerConnection != self.peer) return;
    fprintf(stderr, "native data channel: remote-open label=%s id=%d ordered=%s\n",
            dataChannel.label.UTF8String, dataChannel.channelId,
            dataChannel.isOrdered ? "true" : "false");
    // Kernel's client creates the outbound `data` channel. Do not replace that
    // channel if a future server also opens a channel toward the client.
    if (!self.dataChannel || self.dataChannel.readyState == LKRTCDataChannelStateClosed) {
      self.dataChannel = dataChannel;
      self.dataChannel.delegate = self;
    }
  }
}
- (void)peerConnection:(LKRTCPeerConnection *)peerConnection didAddReceiver:(LKRTCRtpReceiver *)receiver streams:(NSArray<LKRTCMediaStream *> *)mediaStreams {
  (void)mediaStreams;
  @synchronized (self) {
    if (self.closing || peerConnection != self.peer) return;
    if (![receiver.track isKindOfClass:LKRTCVideoTrack.class]) return;
    self.videoTrack = (LKRTCVideoTrack *)receiver.track;
    [self.videoTrack addRenderer:self.frameSink];
    if (self.inputView) [self.videoTrack addRenderer:self.inputView.videoView];
  }
}

- (void)dataChannelDidChangeState:(LKRTCDataChannel *)dataChannel {
  @synchronized (self) {
    if (dataChannel != self.dataChannel) return;
    if (dataChannel.readyState == LKRTCDataChannelStateOpen) [self emitState:KL_NATIVE_DATA_OPEN];
    if (dataChannel.readyState == LKRTCDataChannelStateClosed) [self emitState:KL_NATIVE_DATA_CLOSED];
  }
}
- (void)dataChannel:(LKRTCDataChannel *)dataChannel didReceiveMessageWithBuffer:(LKRTCDataBuffer *)buffer { (void)dataChannel; (void)buffer; }
- (void)videoView:(id<LKRTCVideoRenderer>)videoView didChangeVideoSize:(CGSize)size {
  (void)videoView;
  if (self.inputView) self.inputView.videoSize = size;
}

@end

static KLNativeSession *KLSession(KLNativeSessionHandle *handle) {
  return (__bridge KLNativeSession *)handle;
}

extern "C" KLNativeSessionHandle *kl_native_create(KLNativeCallbacks callbacks) {
  @autoreleasepool {
    KLNativeSession *session = [[KLNativeSession alloc] initWithCallbacks:callbacks];
    return (__bridge_retained KLNativeSessionHandle *)session;
  }
}

extern "C" bool kl_native_attach_appkit(KLNativeSessionHandle *handle,
                                         KLAppKitCallbacks callbacks,
                                         const uint8_t *title,
                                         size_t title_len) {
  @autoreleasepool {
    return [KLSession(handle) createWindowWithCallbacks:callbacks
                                                  title:KLString(title, title_len)];
  }
}

extern "C" void kl_native_connect_websocket(
    KLNativeSessionHandle *handle, const uint8_t *base_url, size_t base_url_len,
    const uint8_t *username, size_t username_len, const uint8_t *password,
    size_t password_len) {
  [KLSession(handle) connectBaseURL:KLString(base_url, base_url_len)
                 username:KLString(username, username_len)
                 password:KLString(password, password_len)];
}

extern "C" void kl_native_create_peer(KLNativeSessionHandle *handle,
                                        const uint8_t *ice_json,
                                        size_t ice_json_len, bool lite) {
  [KLSession(handle) createPeerWithIceJSON:KLString(ice_json, ice_json_len) lite:lite];
}

extern "C" void kl_native_set_remote_description(
    KLNativeSessionHandle *handle, bool answer, const uint8_t *sdp, size_t sdp_len) {
  [KLSession(handle) setRemoteAnswer:answer sdp:KLString(sdp, sdp_len)];
}

extern "C" void kl_native_add_ice_candidate(
    KLNativeSessionHandle *handle, const uint8_t *candidate_json,
    size_t candidate_json_len) {
  [KLSession(handle) addCandidateJSON:KLString(candidate_json, candidate_json_len)];
}

extern "C" bool kl_native_send_websocket(KLNativeSessionHandle *handle,
                                           const uint8_t *bytes, size_t len) {
  return [KLSession(handle) sendWebSocketBytes:bytes length:len];
}

extern "C" bool kl_native_send_data(KLNativeSessionHandle *handle,
                                      const uint8_t *bytes, size_t len) {
  KLNativeSession *session = KLSession(handle);
  @synchronized (session) {
    if (session.closing || !session.dataChannel ||
        session.dataChannel.readyState != LKRTCDataChannelStateOpen) return false;
    NSData *data = [NSData dataWithBytes:bytes length:len];
    return [session.dataChannel sendData:[[LKRTCDataBuffer alloc] initWithData:data isBinary:YES]];
  }
}

extern "C" void kl_native_start_heartbeat(KLNativeSessionHandle *handle,
                                            uint32_t interval_ms) {
  KLNativeSession *session = KLSession(handle);
  @synchronized (session) {
    if (interval_ms == 0 || session.closing) return;
    if (session.heartbeat) dispatch_source_cancel(session.heartbeat);
    dispatch_queue_t queue = dispatch_get_global_queue(QOS_CLASS_UTILITY, 0);
    dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, queue);
    session.heartbeat = timer;
    uint64_t interval = static_cast<uint64_t>(interval_ms) * NSEC_PER_MSEC;
    dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, interval),
                              interval, 100 * NSEC_PER_MSEC);
    __weak KLNativeSession *weakSession = session;
    dispatch_source_set_event_handler(timer, ^{
      KLNativeSession *strongSession = weakSession;
      if (!strongSession) return;
      @synchronized (strongSession) {
        if (strongSession.closing || strongSession.heartbeat != timer) return;
        static const uint8_t message[] = "{\"event\":\"client/heartbeat\"}";
        [strongSession sendWebSocketBytes:message length:sizeof(message) - 1];
      }
    });
    dispatch_resume(timer);
  }
}

extern "C" void kl_native_schedule_paste(KLNativeSessionHandle *handle,
                                           uint32_t delay_ms) {
  KLNativeSession *session = KLSession(handle);
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,
                               static_cast<int64_t>(delay_ms) * NSEC_PER_MSEC),
                 dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @synchronized (session) {
      if (!session.closing && session.callbacks.on_paste_ready &&
          [session beginCallback]) {
        session.callbacks.on_paste_ready(session.callbacks.context);
        [session endCallback];
      }
    }
  });
}

extern "C" void kl_native_schedule_reconnect(KLNativeSessionHandle *handle,
                                                uint32_t delay_ms) {
  [KLSession(handle) scheduleReconnectAfter:delay_ms];
}

extern "C" int kl_native_run_appkit(KLNativeSessionHandle *handle) {
  @autoreleasepool {
    KLNativeSession *session = KLSession(handle);
    [NSApp finishLaunching];
    [session.window makeKeyAndOrderFront:nil];
    [session.window makeFirstResponder:session.inputView];
    [NSApp activateIgnoringOtherApps:YES];
    [NSApp run];
  }
  return 0;
}

extern "C" void kl_native_close(KLNativeSessionHandle *handle) {
  [KLSession(handle) closeNative];
}

extern "C" void kl_native_destroy(KLNativeSessionHandle *handle) {
  KLNativeSession *session = KLSession(handle);
  [session closeNative];
  [session disableCallbacks];
  CFBridgingRelease(handle);
}

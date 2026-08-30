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
@property(nonatomic, strong) NSImageView *remoteCursorView;
@property(nonatomic, strong) NSTextField *statusLabel;
@property(nonatomic, strong) NSTrackingArea *trackingArea;
@property(nonatomic, strong) NSCursor *guestCursor;
@property(nonatomic, strong) NSImage *guestCursorImage;
@property(nonatomic, assign) KLAppKitCursorSnapshot cursorSnapshot;
@property(nonatomic, assign) BOOL pointerInsideVideo;
@property(nonatomic, assign) CGSize videoSize;
- (void)updateRemoteCursorPresentation;
- (void)refreshCursorObservation;
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

  _guestCursor = NSCursor.arrowCursor;
  _cursorSnapshot = KLAppKitCursorSnapshot{};
  _remoteCursorView = [[NSImageView alloc] initWithFrame:NSZeroRect];
  _remoteCursorView.imageScaling = NSImageScaleAxesIndependently;
  _remoteCursorView.hidden = YES;
  [self addSubview:_remoteCursorView];

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
  if (self.window) {
    NSPoint point = [self convertPoint:self.window.mouseLocationOutsideOfEventStream
                              fromView:nil];
    _pointerInsideVideo = NSPointInRect(point, [self fittedVideoRect]);
  }
  [self.window invalidateCursorRectsForView:self];
  [self updateRemoteCursorPresentation];
}
- (void)resetCursorRects {
  [super resetCursorRects];
  NSRect fitted = [self fittedVideoRect];
  if (!NSIsEmptyRect(fitted)) {
    BOOL authorized = (_cursorSnapshot.flags & KL_APPKIT_CURSOR_AUTHORIZED) != 0;
    [self addCursorRect:fitted cursor:authorized ? _guestCursor : NSCursor.arrowCursor];
  }
}

- (void)updateRemoteCursorPresentation {
  BOOL hasImage = (_cursorSnapshot.flags & KL_APPKIT_CURSOR_IMAGE_AVAILABLE) != 0;
  BOOL hasPosition =
      (_cursorSnapshot.flags & KL_APPKIT_CURSOR_POSITION_AVAILABLE) != 0;
  BOOL authorized = (_cursorSnapshot.flags & KL_APPKIT_CURSOR_AUTHORIZED) != 0;
  BOOL remoteController =
      (_cursorSnapshot.flags & KL_APPKIT_CURSOR_REMOTE_CONTROLLER) != 0;
  NSRect fitted = [self fittedVideoRect];
  if (!hasImage || !hasPosition || authorized || !remoteController ||
      _pointerInsideVideo ||
      !_guestCursorImage || NSIsEmptyRect(fitted) || _videoSize.width <= 0 ||
      _videoSize.height <= 0) {
    _remoteCursorView.hidden = YES;
    return;
  }

  CGFloat hotspotX = fitted.origin.x +
      (static_cast<CGFloat>(_cursorSnapshot.position_x) / _videoSize.width) *
          fitted.size.width;
  CGFloat hotspotY = NSMaxY(fitted) -
      (static_cast<CGFloat>(_cursorSnapshot.position_y) / _videoSize.height) *
          fitted.size.height;
  CGFloat scaleX = fitted.size.width / _videoSize.width;
  CGFloat scaleY = fitted.size.height / _videoSize.height;
  NSSize imageSize = NSMakeSize(_guestCursorImage.size.width * scaleX,
                                _guestCursorImage.size.height * scaleY);
  CGFloat originX = hotspotX - _cursorSnapshot.hotspot_x * scaleX;
  CGFloat originY = hotspotY -
      (_guestCursorImage.size.height - _cursorSnapshot.hotspot_y) * scaleY;
  _remoteCursorView.frame = NSMakeRect(originX, originY, imageSize.width,
                                        imageSize.height);
  _remoteCursorView.hidden = NO;
}

- (void)refreshCursorObservation {
  if (!_callbacks.copy_cursor_snapshot) return;
  KLAppKitCursorSnapshot snapshot{};
  if (!_callbacks.copy_cursor_snapshot(_callbacks.context, &snapshot,
                                       sizeof(snapshot)) ||
      snapshot.struct_size != sizeof(snapshot)) return;

  BOOL hasImage = (snapshot.flags & KL_APPKIT_CURSOR_IMAGE_AVAILABLE) != 0;
  BOOL imagePresentationChanged = NO;
  if (hasImage && snapshot.image_generation != _cursorSnapshot.image_generation) {
    NSImage *image = nil;
    BOOL dimensionsValid = snapshot.width > 0 && snapshot.height > 0 &&
        snapshot.width <= 1024 && snapshot.height <= 1024 &&
        snapshot.hotspot_x < snapshot.width && snapshot.hotspot_y < snapshot.height;
    if (_callbacks.copy_cursor_image && dimensionsValid &&
        snapshot.image_byte_length > 0 &&
        snapshot.image_byte_length <= 1024 * 1024) {
      NSMutableData *bytes = [NSMutableData dataWithLength:snapshot.image_byte_length];
      uint32_t copied = _callbacks.copy_cursor_image(
          _callbacks.context, snapshot.image_generation,
          static_cast<uint8_t *>(bytes.mutableBytes), snapshot.image_byte_length);
      if (copied == snapshot.image_byte_length) {
        image = [[NSImage alloc] initWithData:bytes];
      }
    }
    if (image) {
      image.size = NSMakeSize(snapshot.width, snapshot.height);
      _guestCursorImage = image;
      // Neko's X11 hotspot and NSCursor's image hotspot are both measured from
      // the top-left pixel, despite AppKit view coordinates being bottom-up.
      _guestCursor = [[NSCursor alloc]
          initWithImage:image
                hotSpot:NSMakePoint(snapshot.hotspot_x, snapshot.hotspot_y)];
      _remoteCursorView.image = image;
      imagePresentationChanged = YES;
    } else if (_guestCursorImage) {
      _guestCursorImage = nil;
      _guestCursor = NSCursor.arrowCursor;
      _remoteCursorView.image = nil;
      imagePresentationChanged = YES;
    }
  } else if (!hasImage && _guestCursorImage) {
    _guestCursorImage = nil;
    _guestCursor = NSCursor.arrowCursor;
    _remoteCursorView.image = nil;
    imagePresentationChanged = YES;
  }

  BOOL authorizationChanged =
      ((snapshot.flags ^ _cursorSnapshot.flags) & KL_APPKIT_CURSOR_AUTHORIZED) != 0;
  _cursorSnapshot = snapshot;
  if (authorizationChanged || imagePresentationChanged) {
    [self.window invalidateCursorRectsForView:self];
  }
  [self updateRemoteCursorPresentation];
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
           options:NSTrackingMouseMoved | NSTrackingMouseEnteredAndExited |
                   NSTrackingActiveInKeyWindow | NSTrackingInVisibleRect
             owner:self
          userInfo:nil];
  [self addTrackingArea:_trackingArea];
  [super updateTrackingAreas];
}

- (void)sendPointer:(NSEvent *)event kind:(uint8_t)kind button:(uint8_t)button {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  _pointerInsideVideo = NSPointInRect(point, [self fittedVideoRect]);
  [self updateRemoteCursorPresentation];
  if (!_callbacks.on_pointer) return;
  _callbacks.on_pointer(_callbacks.context, point.x, point.y,
                        self.bounds.size.width, self.bounds.size.height, kind,
                        button, 0, 0,
                        (event.modifierFlags & NSEventModifierFlagControl) != 0);
}

- (void)mouseEntered:(NSEvent *)event {
  NSPoint point = [self convertPoint:event.locationInWindow fromView:nil];
  _pointerInsideVideo = NSPointInRect(point, [self fittedVideoRect]);
  [self updateRemoteCursorPresentation];
}
- (void)mouseExited:(NSEvent *)event {
  (void)event;
  _pointerInsideVideo = NO;
  [self updateRemoteCursorPresentation];
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
@property(nonatomic, strong) NSCondition *transportResetCondition;
@property(nonatomic, assign) BOOL transportResetting;
@property(nonatomic, copy) NSString *windowTitle;
@property(nonatomic, strong) NSWindow *window;
@property(nonatomic, strong) KLInputView *inputView;
@property(nonatomic, strong) id commandKeyUpMonitor;
// The transport object graph and reconnect flags are accessed only while
// synchronized on this session. NSURLSession and WebRTC use different worker
// queues, so property-level atomicity would not make a reset coherent.
@property(nonatomic, strong) NSURLSession *urlSession;
@property(nonatomic, strong) NSURLSessionDataTask *loginTask;
@property(nonatomic, strong) NSURLSessionWebSocketTask *webSocket;
@property(nonatomic, copy) NSString *baseURL;
@property(nonatomic, copy) NSString *authToken;
@property(nonatomic, strong) dispatch_source_t heartbeat;
@property(nonatomic, strong) LKRTCPeerConnectionFactory *factory;
@property(nonatomic, strong) LKRTCPeerConnection *peer;
@property(nonatomic, strong) NSMutableArray<LKRTCIceCandidate *> *pendingRemoteCandidates;
@property(nonatomic, assign) BOOL remoteDescriptionReady;
@property(nonatomic, strong) LKRTCDataChannel *outboundDataChannel;
@property(nonatomic, strong) LKRTCDataChannel *inboundDataChannel;
@property(nonatomic, strong) LKRTCVideoTrack *videoTrack;
@property(nonatomic, strong) KLFrameSink *frameSink;
@property(nonatomic, strong) NSTimer *statusTimer;
@property(nonatomic, assign) BOOL closing;
@property(nonatomic, assign) BOOL reconnectScheduled;
- (void)addRemoteCandidate:(LKRTCIceCandidate *)candidate
                       peer:(LKRTCPeerConnection *)peer;
@end

@implementation KLNativeSession

- (instancetype)initWithCallbacks:(KLNativeCallbacks)callbacks {
  self = [super init];
  if (!self) return nil;
  _callbacks = callbacks;
  _callbackCondition = [NSCondition new];
  _callbacksEnabled = YES;
  _transportResetCondition = [NSCondition new];
  _pendingRemoteCandidates = [NSMutableArray new];
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

- (BOOL)isCurrentWebSocketTask:(NSURLSessionWebSocketTask *)task {
  @synchronized (self) {
    return !self.closing && task == self.webSocket;
  }
}

- (BOOL)isCurrentPeer:(LKRTCPeerConnection *)peer {
  @synchronized (self) {
    return !self.closing && peer == self.peer;
  }
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
  // AppKit does not route a key-up through the ordinary responder chain when
  // the key was released while Command remained held. Recover only events for
  // this focused Live View and consume them so a future AppKit change cannot
  // deliver the same release twice.
  self.commandKeyUpMonitor = [NSEvent
      addLocalMonitorForEventsMatchingMask:NSEventMaskKeyUp
                                  handler:^NSEvent *(NSEvent *event) {
    KLNativeSession *strongSelf = weakSelf;
    if (!strongSelf || strongSelf.closing ||
        (event.modifierFlags & NSEventModifierFlagCommand) == 0) {
      return event;
    }
    NSWindow *window = strongSelf.window;
    KLInputView *inputView = strongSelf.inputView;
    if (!window || !inputView || event.window != window ||
        window.firstResponder != inputView) {
      return event;
    }
    [inputView keyUp:event];
    return nil;
  }];
  self.statusTimer = [NSTimer scheduledTimerWithTimeInterval:(1.0 / 30.0)
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
    [strongSelf.inputView refreshCursorObservation];
  }];
  return YES;
}

- (NSURL *)URLForBaseURL:(NSString *)baseURL
                    path:(NSString *)suffix
         websocketScheme:(BOOL)websocketScheme
              queryItems:(NSArray<NSURLQueryItem *> *)queryItems {
  NSURLComponents *components = [NSURLComponents componentsWithString:baseURL];
  if (!components || !components.scheme || !components.host) return nil;
  if (websocketScheme) {
    components.scheme = [components.scheme.lowercaseString isEqualToString:@"https"] ? @"wss" : @"ws";
  }
  NSString *path = components.path ?: @"";
  if ([path hasSuffix:@"/"]) path = [path substringToIndex:path.length - 1];
  components.path = [path stringByAppendingString:suffix];
  if (queryItems.count != 0) {
    NSMutableArray<NSURLQueryItem *> *items =
        [NSMutableArray arrayWithArray:components.queryItems ?: @[]];
    [items addObjectsFromArray:queryItems];
    components.queryItems = items;
  }
  return components.URL;
}

- (void)openWebSocketForBaseURL:(NSString *)baseURL
                          token:(NSString *)token
                        session:(NSURLSession *)urlSession {
  NSURL *url = [self URLForBaseURL:baseURL
                              path:@"/api/ws"
                   websocketScheme:YES
                        queryItems:@[[NSURLQueryItem queryItemWithName:@"token" value:token]]];
  if (!url) {
    [self reportError:@"invalid websocket URL"];
    return;
  }
  @synchronized (self) {
    if (self.closing || urlSession != self.urlSession) return;
    self.webSocket = [urlSession webSocketTaskWithURL:url];
    [self.webSocket resume];
  }
}

- (void)connectBaseURL:(NSString *)baseURL
              username:(NSString *)username
              password:(NSString *)password {
  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.timeoutIntervalForRequest = 15;
  NSURLSession *urlSession =
      [NSURLSession sessionWithConfiguration:configuration delegate:self delegateQueue:nil];
  NSString *existingToken;
  @synchronized (self) {
    if (self.closing) {
      [urlSession invalidateAndCancel];
      return;
    }
    self.baseURL = baseURL;
    self.urlSession = urlSession;
    existingToken = self.authToken;
  }
  if (existingToken.length != 0) {
    [self openWebSocketForBaseURL:baseURL token:existingToken session:urlSession];
    return;
  }

  NSURL *loginURL = [self URLForBaseURL:baseURL
                                   path:@"/api/login"
                        websocketScheme:NO
                             queryItems:@[]];
  if (!loginURL) {
    [self reportError:@"invalid login URL"];
    return;
  }
  NSDictionary *credentials = @{ @"username" : username, @"password" : password };
  NSData *body = [NSJSONSerialization dataWithJSONObject:credentials options:0 error:nil];
  if (!body) {
    [self reportError:@"could not encode login request"];
    return;
  }
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:loginURL];
  request.HTTPMethod = @"POST";
  request.HTTPBody = body;
  [request setValue:@"application/json" forHTTPHeaderField:@"Content-Type"];

  __weak KLNativeSession *weakSelf = self;
  __block NSURLSessionDataTask *loginTask = nil;
  loginTask = [urlSession dataTaskWithRequest:request
                           completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    KLNativeSession *strongSelf = weakSelf;
    if (!strongSelf) return;
    NSHTTPURLResponse *http = [response isKindOfClass:NSHTTPURLResponse.class]
                                  ? (NSHTTPURLResponse *)response
                                  : nil;
    NSDictionary *value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    NSString *token = [value isKindOfClass:NSDictionary.class] &&
                              [value[@"token"] isKindOfClass:NSString.class]
                          ? value[@"token"]
                          : nil;
    @synchronized (strongSelf) {
      if (strongSelf.closing || strongSelf.urlSession != urlSession ||
          strongSelf.loginTask != loginTask) return;
      strongSelf.loginTask = nil;
      if (!error && http.statusCode >= 200 && http.statusCode < 300 && token.length != 0) {
        strongSelf.authToken = token;
      }
    }
    if (error || http.statusCode < 200 || http.statusCode >= 300 || token.length == 0) {
      [strongSelf reportError:@"Live View authentication failed"];
      return;
    }
    [strongSelf openWebSocketForBaseURL:baseURL token:token session:urlSession];
  }];
  @synchronized (self) {
    if (self.closing || self.urlSession != urlSession) {
      [loginTask cancel];
      return;
    }
    self.loginTask = loginTask;
  }
  [loginTask resume];
}

- (void)logoutBaseURL:(NSString *)baseURL token:(NSString *)token {
  if (baseURL.length == 0 || token.length == 0) return;
  NSURL *logoutURL = [self URLForBaseURL:baseURL
                                    path:@"/api/logout"
                         websocketScheme:NO
                              queryItems:@[]];
  if (!logoutURL) return;
  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:logoutURL];
  request.HTTPMethod = @"POST";
  [request setValue:[@"Bearer " stringByAppendingString:token]
      forHTTPHeaderField:@"Authorization"];
  NSURLSessionConfiguration *configuration = NSURLSessionConfiguration.ephemeralSessionConfiguration;
  configuration.timeoutIntervalForRequest = 0.5;
  NSURLSession *session = [NSURLSession sessionWithConfiguration:configuration];
  dispatch_semaphore_t completed = dispatch_semaphore_create(0);
  NSURLSessionDataTask *task = [session dataTaskWithRequest:request
                                         completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
    (void)data;
    (void)response;
    (void)error;
    dispatch_semaphore_signal(completed);
  }];
  [task resume];
  dispatch_semaphore_wait(completed,
                          dispatch_time(DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC));
  [session invalidateAndCancel];
}

- (void)receiveNextMessage {
  NSURLSessionWebSocketTask *task;
  @synchronized (self) {
    if (self.closing || !self.webSocket) return;
    task = self.webSocket;
  }
  __weak KLNativeSession *weakSelf = self;
  [task receiveMessageWithCompletionHandler:^(NSURLSessionWebSocketMessage *message, NSError *error) {
    KLNativeSession *strongSelf = weakSelf;
    if (!strongSelf || ![strongSelf isCurrentWebSocketTask:task]) return;
    if (error) {
      [strongSelf reportError:@"websocket receive failed"];
      [strongSelf emitState:KL_NATIVE_WS_CLOSED];
      return;
    }
    NSString *text = message.string;
    if (text && strongSelf.callbacks.on_websocket_message &&
        [strongSelf beginCallback]) {
      if ([strongSelf isCurrentWebSocketTask:task]) {
        KLBytes(text, ^(const uint8_t *bytes, size_t len) {
          strongSelf.callbacks.on_websocket_message(strongSelf.callbacks.context, bytes, len);
        });
      }
      [strongSelf endCallback];
    }
    if ([strongSelf isCurrentWebSocketTask:task]) [strongSelf receiveNextMessage];
  }];
}

- (BOOL)sendWebSocketBytes:(const uint8_t *)bytes length:(size_t)len {
  NSURLSessionWebSocketTask *task;
  @synchronized (self) {
    if (!self.webSocket || self.closing) return NO;
    task = self.webSocket;
  }
  NSString *text = KLString(bytes, len);
  NSURLSessionWebSocketMessage *message = [[NSURLSessionWebSocketMessage alloc] initWithString:text];
  [task sendMessage:message completionHandler:^(NSError *error) {
    if (error && [self isCurrentWebSocketTask:task]) {
      [self reportError:@"websocket send failed"];
      [self emitState:KL_NATIVE_WS_CLOSED];
    }
  }];
  return YES;
}

- (void)createPeerWithIceJSON:(NSString *)iceJSON lite:(BOOL)lite {
  [self.transportResetCondition lock];
  BOOL resetting = self.transportResetting;
  [self.transportResetCondition unlock];
  if (resetting) return;
  @synchronized (self) {
    if (self.closing || self.peer) return;
  }

  LKRTCDefaultVideoEncoderFactory *encoder = [LKRTCDefaultVideoEncoderFactory new];
  LKRTCDefaultVideoDecoderFactory *decoder = [LKRTCDefaultVideoDecoderFactory new];
  LKRTCPeerConnectionFactory *factory =
      [[LKRTCPeerConnectionFactory alloc] initWithEncoderFactory:encoder decoderFactory:decoder];

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
  LKRTCMediaConstraints *constraints =
      [[LKRTCMediaConstraints alloc] initWithMandatoryConstraints:mandatory optionalConstraints:nil];
  LKRTCPeerConnection *peer =
      [factory peerConnectionWithConfiguration:configuration constraints:constraints delegate:self];
  if (!peer) {
    [self reportError:@"peer creation failed"];
    return;
  }
  LKRTCDataChannelConfiguration *dataConfiguration = [LKRTCDataChannelConfiguration new];
  LKRTCDataChannel *outboundDataChannel =
      [peer dataChannelForLabel:@"data" configuration:dataConfiguration];
  outboundDataChannel.delegate = self;

  BOOL adopted = NO;
  [self.transportResetCondition lock];
  if (!self.transportResetting) {
    @synchronized (self) {
      if (!self.closing && !self.peer) {
        self.factory = factory;
        self.peer = peer;
        if (!self.pendingRemoteCandidates) self.pendingRemoteCandidates = [NSMutableArray new];
        self.remoteDescriptionReady = NO;
        self.outboundDataChannel = outboundDataChannel;
        adopted = YES;
      }
    }
  }
  [self.transportResetCondition unlock];
  if (!adopted) {
    outboundDataChannel.delegate = nil;
    [outboundDataChannel close];
    peer.delegate = nil;
    [peer close];
    return;
  }
  [self emitState:KL_NATIVE_PEER_CONNECTING];
}

- (void)setRemoteAnswer:(BOOL)answer sdp:(NSString *)sdp {
  LKRTCPeerConnection *peer;
  BOOL closing;
  @synchronized (self) {
    closing = self.closing;
    peer = closing ? nil : self.peer;
  }
  if (!peer) {
    if (!closing) [self reportError:@"remote description arrived before peer creation"];
    return;
  }
  LKRTCSessionDescription *description = [[LKRTCSessionDescription alloc]
      initWithType:answer ? LKRTCSdpTypeAnswer : LKRTCSdpTypeOffer
               sdp:sdp];
  __weak KLNativeSession *weakSelf = self;
  __weak LKRTCPeerConnection *weakPeer = peer;
  [peer setRemoteDescription:description completionHandler:^(NSError *error) {
    KLNativeSession *remoteSelf = weakSelf;
    LKRTCPeerConnection *remotePeer = weakPeer;
    if (!remoteSelf || !remotePeer || ![remoteSelf isCurrentPeer:remotePeer]) return;
    if (error) {
      [remoteSelf reportError:@"set remote description failed"];
      return;
    }
    NSArray<LKRTCIceCandidate *> *pendingCandidates;
    @synchronized (remoteSelf) {
      if (remoteSelf.closing || remoteSelf.peer != remotePeer) return;
      remoteSelf.remoteDescriptionReady = YES;
      pendingCandidates = [remoteSelf.pendingRemoteCandidates copy];
      [remoteSelf.pendingRemoteCandidates removeAllObjects];
    }
    for (LKRTCIceCandidate *candidate in pendingCandidates) {
      [remoteSelf addRemoteCandidate:candidate peer:remotePeer];
    }
    if (answer) return;
    LKRTCMediaConstraints *constraints =
        [[LKRTCMediaConstraints alloc] initWithMandatoryConstraints:nil optionalConstraints:nil];
    [remotePeer answerForConstraints:constraints completionHandler:^(LKRTCSessionDescription *local, NSError *answerError) {
      KLNativeSession *answerSelf = weakSelf;
      LKRTCPeerConnection *answerPeer = weakPeer;
      if (!answerSelf || !answerPeer || ![answerSelf isCurrentPeer:answerPeer]) return;
      if (answerError || !local) {
        [answerSelf reportError:@"create answer failed"];
        return;
      }
      [answerPeer setLocalDescription:local completionHandler:^(NSError *localError) {
        KLNativeSession *localSelf = weakSelf;
        LKRTCPeerConnection *localPeer = weakPeer;
        if (!localSelf || !localPeer || ![localSelf isCurrentPeer:localPeer]) return;
        if (localError) {
          [localSelf reportError:@"set local description failed"];
          return;
        }
        if (localSelf.callbacks.on_local_description && [localSelf beginCallback]) {
          if ([localSelf isCurrentPeer:localPeer]) {
            KLBytes(local.sdp, ^(const uint8_t *bytes, size_t len) {
              localSelf.callbacks.on_local_description(localSelf.callbacks.context, true, bytes, len);
            });
          }
          [localSelf endCallback];
        }
      }];
    }];
  }];
}

- (void)addRemoteCandidate:(LKRTCIceCandidate *)candidate
                       peer:(LKRTCPeerConnection *)peer {
  __weak KLNativeSession *weakSelf = self;
  __weak LKRTCPeerConnection *weakPeer = peer;
  [peer addIceCandidate:candidate completionHandler:^(NSError *error) {
    KLNativeSession *strongSelf = weakSelf;
    LKRTCPeerConnection *strongPeer = weakPeer;
    if (error && strongSelf && strongPeer && [strongSelf isCurrentPeer:strongPeer]) {
      [strongSelf reportError:@"add ICE candidate failed"];
    }
  }];
}

- (void)addCandidateJSON:(NSString *)candidateJSON {
  NSData *data = [candidateJSON dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *value = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (![value isKindOfClass:NSDictionary.class]) return;
  NSString *candidate = [value[@"candidate"] isKindOfClass:NSString.class] ? value[@"candidate"] : nil;
  NSString *mid = [value[@"sdpMid"] isKindOfClass:NSString.class] ? value[@"sdpMid"] : nil;
  NSNumber *line = [value[@"sdpMLineIndex"] isKindOfClass:NSNumber.class] ? value[@"sdpMLineIndex"] : @0;
  if (!candidate) return;
  LKRTCIceCandidate *ice = [[LKRTCIceCandidate alloc]
      initWithSdp:candidate sdpMLineIndex:line.intValue sdpMid:mid];
  LKRTCPeerConnection *peer;
  @synchronized (self) {
    if (self.closing) return;
    peer = self.peer;
    if (!peer || !self.remoteDescriptionReady) {
      [self.pendingRemoteCandidates addObject:ice];
      return;
    }
  }
  [self addRemoteCandidate:ice peer:peer];
}

- (void)resetTransport {
  dispatch_source_t heartbeat;
  KLFrameSink *frameSink;
  KLInputView *inputView;
  LKRTCVideoTrack *videoTrack;
  LKRTCDataChannel *outboundDataChannel;
  LKRTCDataChannel *inboundDataChannel;
  LKRTCPeerConnection *peer;
  NSURLSessionDataTask *loginTask;
  NSURLSessionWebSocketTask *webSocket;
  NSURLSession *urlSession;
  LKRTCPeerConnectionFactory *factory;
  [self.transportResetCondition lock];
  while (self.transportResetting) [self.transportResetCondition wait];
  self.transportResetting = YES;
  [self.transportResetCondition unlock];
  @try {
    @synchronized (self) {
      heartbeat = self.heartbeat;
      self.heartbeat = nil;
      frameSink = self.frameSink;
      inputView = self.inputView;
      videoTrack = self.videoTrack;
      self.videoTrack = nil;
      outboundDataChannel = self.outboundDataChannel;
      self.outboundDataChannel = nil;
      inboundDataChannel = self.inboundDataChannel;
      self.inboundDataChannel = nil;
      peer = self.peer;
      self.peer = nil;
      self.pendingRemoteCandidates = [NSMutableArray new];
      self.remoteDescriptionReady = NO;
      loginTask = self.loginTask;
      self.loginTask = nil;
      webSocket = self.webSocket;
      self.webSocket = nil;
      urlSession = self.urlSession;
      self.urlSession = nil;
      factory = self.factory;
      self.factory = nil;
      outboundDataChannel.delegate = nil;
      inboundDataChannel.delegate = nil;
      peer.delegate = nil;
    }
    if (heartbeat) dispatch_source_cancel(heartbeat);
    [frameSink.callbackLock lock];
    frameSink.enabled = NO;
    [frameSink.callbackLock unlock];
    if (videoTrack) {
      [videoTrack removeRenderer:frameSink];
      if (inputView) [videoTrack removeRenderer:inputView.videoView];
    }
    [loginTask cancel];
    [outboundDataChannel close];
    [inboundDataChannel close];
    [peer close];
    [webSocket cancelWithCloseCode:NSURLSessionWebSocketCloseCodeNormalClosure reason:nil];
    [urlSession invalidateAndCancel];
    (void)factory;
  } @finally {
    [self.transportResetCondition lock];
    self.transportResetting = NO;
    [self.transportResetCondition broadcast];
    [self.transportResetCondition unlock];
  }
}

- (void)closeNative {
  BOOL shouldReset = NO;
  id commandKeyUpMonitor;
  NSString *baseURL;
  NSString *authToken;
  @synchronized (self) {
    if (self.closing) return;
    self.closing = YES;
    baseURL = self.baseURL;
    authToken = self.authToken;
    self.authToken = nil;
    commandKeyUpMonitor = self.commandKeyUpMonitor;
    self.commandKeyUpMonitor = nil;
    [self.statusTimer invalidate];
    self.statusTimer = nil;
    shouldReset = YES;
  }
  if (shouldReset) {
    if (commandKeyUpMonitor) [NSEvent removeMonitor:commandKeyUpMonitor];
    [self disableCallbacks];
    [self logoutBaseURL:baseURL token:authToken];
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
    }
    [self resetTransport];
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
    // Input stays on the client-created channel. Retain Neko's independently
    // created channel too; cursor observations can arrive on either stream
    // when Neko's pinned legacy compatibility handoff changes its active
    // channel after SCTP setup.
    if (!self.inboundDataChannel ||
        self.inboundDataChannel.readyState == LKRTCDataChannelStateClosed) {
      self.inboundDataChannel = dataChannel;
      self.inboundDataChannel.delegate = self;
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
    if (dataChannel != self.outboundDataChannel) return;
    if (dataChannel.readyState == LKRTCDataChannelStateOpen) [self emitState:KL_NATIVE_DATA_OPEN];
    if (dataChannel.readyState == LKRTCDataChannelStateClosed) [self emitState:KL_NATIVE_DATA_CLOSED];
  }
}
- (void)dataChannel:(LKRTCDataChannel *)dataChannel
    didReceiveMessageWithBuffer:(LKRTCDataBuffer *)buffer {
  @synchronized (self) {
    BOOL knownChannel = dataChannel == self.inboundDataChannel ||
        dataChannel == self.outboundDataChannel;
    if (self.closing || !knownChannel ||
        !buffer.isBinary || !self.callbacks.on_data_message ||
        ![self beginCallback]) return;
    // Keep resetTransport serialized behind this callback. Otherwise an old
    // channel can pass the identity check, pause here, and repopulate cursor
    // state after the reconnect path has cleared it.
    NSData *data = buffer.data;
    self.callbacks.on_data_message(
        self.callbacks.context, static_cast<const uint8_t *>(data.bytes), data.length);
    [self endCallback];
  }
}
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

extern "C" void kl_native_connect(
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
    if (session.closing || !session.outboundDataChannel ||
        session.outboundDataChannel.readyState != LKRTCDataChannelStateOpen) return false;
    NSData *data = [NSData dataWithBytes:bytes length:len];
    return [session.outboundDataChannel
        sendData:[[LKRTCDataBuffer alloc] initWithData:data isBinary:YES]];
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

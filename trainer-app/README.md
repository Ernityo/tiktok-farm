# Swipe Trainer

A tiny iOS app that asks you to swipe up and double tap in different positions and hand setups, and saves every touch to a JSON file. Nothing is sent to the phone's apps, and no input is injected, so the data is your real touch.

Each session file is tagged with the phone's UDID (type it in the app). Files are saved to `recordings/` in the repo after you copy them off the phone.

## One-time setup

The project file is generated from `project.yml` with XcodeGen (already installed here: `brew install xcodegen`).

```sh
cd trainer-app
xcodegen generate
```

## Install on your phone (click by click)

1. Plug the iPhone into the Mac and unlock it. If it asks "Trust This Computer?", tap **Trust**.
2. Turn off Tailscale / NordVPN while you do this. They break the Xcode ↔ iPhone link (see the memory note).
3. Double-click `TrainerApp.xcodeproj` to open it in Xcode.
4. In the left sidebar, click the blue **TrainerApp** project, then the **TrainerApp** target.
5. Open the **Signing & Capabilities** tab.
6. Tick **Automatically manage signing**, then pick your Apple ID under **Team**. If the bundle ID is taken, change `com.example.swipetrainer` to something unique (for example `com.yourname.swipetrainer`).
7. In the top toolbar, click the device menu and pick your iPhone (not a simulator).
8. Press the **Run** ▶ button.
9. On the phone, the first launch may say the developer is untrusted. Go to **Settings → General → VPN & Device Management**, tap your Apple ID, then **Trust**. Launch the app again.

## Rebuild for another phone (terminal)

iOS doesn't let apps read their own UDID, so the build takes it from `PHONE_UDID`. Build, install and launch in one go:

```sh
cd trainer-app
UDID=<phone-udid>   # the phone's UDID from devices.json
xcodebuild -project TrainerApp.xcodeproj -scheme TrainerApp -destination "id=$UDID" \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=<your-team-id> PHONE_UDID=$UDID \
  -derivedDataPath build/DerivedData build
xcrun devicectl device install app --device $UDID build/DerivedData/Build/Products/Debug-iphoneos/TrainerApp.app
xcrun devicectl device process launch --device $UDID com.example.swipetrainer
```

## Recording a session

1. Open **Swipe Trainer**. The UDID field is already filled in, because the build sets it from the phone's UDID. To build for a different phone, see "Rebuild for another phone" below.
2. Tap **Start**.
3. Read the instruction at the top (for example "Lying on your side in bed, phone in right hand, right thumb"). Do the gesture on the screen:
   - **Swipe up** to go to the next video.
   - **Double tap** to "like" (a heart appears).
4. Each step asks for 10 counted gestures. Only the gesture the step asks for counts. Others are still saved but marked as not counted.
5. Use **Skip** to move on, or **Stop** to end early.
6. When finished, the screen shows the file name. Tap **Share file** to send it, or copy it off the phone with Finder (below).

### Copy the file to the Mac

1. Plug the phone into the Mac.
2. Open **Finder**, click the iPhone in the sidebar, then the **Files** tab.
3. Open **Swipe Trainer** and drag the `trainer-….json` file to `trainer-app/recordings/` in the repo.

## What is in the file

- `phoneUDID`, `startedAt`, screen size, and the step list.
- `gestures`: one entry per gesture, with the step's position and hands, the gesture asked for, what was detected (`swipe_up`, `swipe_down`, `swipe_side`, `tap`, `double_tap`, `other`), whether it counted, and the raw touch samples (time, x/y in points, x/y as a 0–1 fraction of the screen, finger radius, and force if the phone reports it).
- A double tap is saved twice: once as a `tap` for each finger-down, and once as a `double_tap` combining both. Use `double_tap` for training.

## Limits

- It records the first finger that touches the screen. If you hold the phone and a resting finger touches the screen first, the trainer follows the next finger that starts moving. If the swiping finger lands first and the holding finger lands while it is still, the holding finger may be picked up by mistake. Note this in the session if it happens.
- The phone can't tell which hand is touching it. The hand setup comes from the step's instruction, so follow it closely.
- Customise the positions and hand setups in `TrainerApp/Steps.swift`.

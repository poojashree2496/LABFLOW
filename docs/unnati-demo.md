# Intel Unnati AI Lab demo

The local Test Lab includes `UNNATI` / **Intel Unnati AI Lab** as a fourth lab in all presets. This seed lives in `dev/world.js` and is excluded from Apps Script deployment. It creates no Google resources.

The building, room, coordinates, geofence radius, capacity, hours, equipment counts/models and project records are **demo placeholders**. Lab notes, asset tags, asset notes and project descriptions mark them accordingly. The GPS point is a synthetic offset from the existing test geofence; it is not a surveyed lab location. Confirmed details remain task C5, expected on 21 October.

## Included

- 30 individually tracked GPU workstations in a category marked `workstation`, with three occupied and 27 unclaimed at startup.
- Two 3D printers, two drones and six development boards, individually tracked with `DEMO-UNNATI-` asset tags. No hardware model, serial number or valuation is asserted.
- Open-lab hours 08:00–19:00, capacity 30, both check-in modes and a `kiosk4@karunya.edu` demo door identity.
- Three projects supervised by `faculty2@karunya.edu`: Image classification (active), Drone navigation (pending), Sensor anomaly detection (active). These are sample project records.
- Students 10, 11 and 12 checked in at 09:50 on systems 01, 02 and 03 with their respective projects, before the Test Lab clock starts at 09:54. Their entries use the real kiosk/GPS attendance workflow on fakes.

The original IoT, GPU and Computing labs and their existing demos remain available.

## Walkthrough

1. Run `npm run dev`, open `/lab`, and rebuild any preset if the server was already running.
2. Open `student10@karunya.edu`. Today shows Unnati occupancy and the student's current project/system. Use **Change system / project** to try a mid-visit change. Students 11 and 12 show the other two examples.
3. In the Test Lab Stage, choose **Unnati demo door** as the kiosk and **Unnati lab (demo GPS)** as the phone location before testing a new kiosk/GPS scan. Device-QR mode still requires registering the student's device.
4. Open the staff inventory and filter to Unnati to inspect the equipment. Open admin Labs > Edit Intel Unnati AI Lab to inspect its placeholder settings.
5. Advance the clock beyond 19:00 and run the session tick. The three visits close automatically, crediting through 19:00, with auto sign-out details in student history. The systems are released. A new daily open-lab session is available the next morning.

The separate live board listing all students, projects and systems remains task B4. Current assignments can already be inspected on each student's Today screen and through `Work.current` / `Work.occupants`.

## Replacing placeholders

Update `seedUnnati` and `LAB_UNNATI` in `dev/world.js` with the confirmed building, room, door GPS/radius, hours, capacity and asset list. Keep `lab.labs.UNNATI` aligned with the lab coordinates so simulated phone GPS follows the same geofence. Update `test/dev-world.test.js` assertions and this page. Real campus GPS and Google deployment checks remain separate from this local seed.

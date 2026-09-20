// App-only viewer: fit the primary application into the Orbit frame.
// Dialogs and menus keep their native geometry. No privileged parent bridge.
if (new URLSearchParams(location.search).get('orbit_app') === '1') {
 let primary;
 const fit = () => {
  if (typeof client === 'undefined' || !client.connected) return;
  const windows = Object.values(client.id_to_window);
  if (!windows.includes(primary)) primary = windows.find(w => !w.override_redirect && w.resizable && !w.metadata['transient-for'] && !w.has_windowtype(['DIALOG','UTILITY','SPLASH','MENU','POPUP_MENU','TOOLTIP']));
  if (!primary) return;
  if (!primary.orbitFitted) {
   primary._set_decorated(false);
   primary.set_maximized(true);
   primary.orbitFitted = true;
  }
  const [width,height] = client._get_desktop_size();
  if (primary.w !== width || primary.h !== height || primary.x !== 0 || primary.y !== 0) {
   primary.x=0; primary.y=0; primary.w=width; primary.h=height;
   primary.handle_resized();
  }
 };
 setInterval(fit,500);
}

/* CrowdCab live map and map preview logic.
   Owns Leaflet setup, pickup marker rendering, recommendation tabs, and selected pickup state. */
(function(){
  const C = window.CrowdCab;
  if(!C) return;
  const {qs, qsa, getJSON, crowdClass, customerLabelCrowd, safeText} = C;

  const state = { liveMap:null, mapData:null, recommendationData:null, markerLayer:null, trafficLayer:null, routeMarkerLayer:null, selectedZone:null, pickupMarkerMap:{}, routeLine:null, routeSteps:[], routeFallback:false, activeStep:'plan', venueId:'suncorp_stadium', userLocation:null, userMarker:null, loadRequestId:0 };
  const VENUE_STORAGE_KEY = 'crowdcab_selected_venue';
  const USER_LOCATION_STORAGE_KEY = 'crowdcab_user_location';
  const DESTINATION_STORAGE_KEY = C.destinationStorageKey || 'crowdcab_destination';
  const VENUE_ANCHORS = {
    suncorp_stadium: {venue_id:'suncorp_stadium', name:'Suncorp Stadium', short_name:'Suncorp', lat:-27.4648, lng:153.0095},
    queensland_tennis_centre: {venue_id:'queensland_tennis_centre', name:'Queensland Tennis Centre', short_name:'QTC', lat:-27.525518, lng:153.007202},
    chandler_sports_precinct: {venue_id:'chandler_sports_precinct', name:'Chandler Sports Precinct', short_name:'Chandler', lat:-27.51135, lng:153.1476},
    brisbane_showgrounds: {venue_id:'brisbane_showgrounds', name:'Brisbane Showgrounds', short_name:'Showgrounds', lat:-27.4508, lng:153.0324},
    ballymore_stadium: {venue_id:'ballymore_stadium', name:'Ballymore Stadium', short_name:'Ballymore', lat:-27.4398, lng:153.0161},
    brisbane_arena: {venue_id:'brisbane_arena', name:'Brisbane Arena', short_name:'Brisbane Arena', lat:-27.4643, lng:153.018},
    brisbane_aquatic_centre: {venue_id:'brisbane_aquatic_centre', name:'Brisbane Aquatic Centre', short_name:'Aquatic Centre', lat:-27.512045, lng:153.14865}
  };

  function markerIcon(type, crowd='easy'){
    const cls = type === 'stadium' ? 'stadium-dot' : type === 'cab' ? 'cab-dot' : `map-marker marker-${crowd}`;
    return L.divIcon({className:'', html:`<div class="${cls}"></div>`, iconSize:[34,34], iconAnchor:[17,17]});
  }
  function userLocationIcon(){
    return L.divIcon({className:'', html:`<div class="my-location-marker"><span></span></div>`, iconSize:[42,42], iconAnchor:[21,21]});
  }
  function trafficIcon(eventType='info'){
    const severe = ['crash', 'closure', 'roadwork_closure'].includes(eventType);
    const caution = ['hazard', 'flood', 'special_event'].includes(eventType);
    const cls = severe ? 'traffic-red' : caution ? 'traffic-yellow' : 'traffic-blue';
    return L.divIcon({className:'', html:`<div class="traffic-event-marker ${cls}"></div>`, iconSize:[22,22], iconAnchor:[11,11]});
  }

  function pickupCrowdFromScore(p){
    const score = Number(p.congestion_score ?? 70);
    return score >= 70 ? 'easy' : score >= 45 ? 'medium' : 'busy';
  }
  function cabEtaForPickup(p){
    return Math.max(4, Math.round(Number(p.walk_min || 5) + (Number(p.congestion_score || 60) < 50 ? 3 : 1)));
  }
  function routeReason(p){
    return safeText(p.live_traffic_note || p.reason || 'Live scoring is checking walk, traffic, safety and driver access.');
  }
  function selectedVenueId(){
    return state.venueId || localStorage.getItem(VENUE_STORAGE_KEY) || 'suncorp_stadium';
  }
  function venueLabel(venueId){
    const match = (state.mapData?.venues || []).find(v => v.venue_id === venueId);
    if(match) return match.name || match.short_name || venueId;
    const option = qs(`[data-venue-id="${venueId}"]`);
    return option?.textContent?.trim() || 'Suncorp Stadium';
  }
  function venueAnchor(venueId){
    return (state.mapData?.venues || []).find(v => v.venue_id === venueId) || VENUE_ANCHORS[venueId] || VENUE_ANCHORS.suncorp_stadium;
  }
  function venueQuery(){
    const params = new URLSearchParams({venue_id:selectedVenueId()});
    if(state.userLocation?.lat && state.userLocation?.lng){
      params.set('user_lat', state.userLocation.lat);
      params.set('user_lng', state.userLocation.lng);
    }
    return params.toString();
  }
  function toMapPickup(p){
    if(p.lat && p.lng) return p;
    return {
      ...p,
      zone: p.pickup_point_id || p.label,
      lat: p.latitude,
      lng: p.longitude,
      eta: cabEtaForPickup(p),
      crowd: pickupCrowdFromScore(p),
      accessible: Math.round(Number(p.accessibility_score || 0)),
      score: p.total_score
    };
  }
  function scoredPickups(){
    return (state.recommendationData?.recommendations || []).map(toMapPickup);
  }

  function destinationValue(fallback='No destination selected yet.'){
    const value = (qs('#destinationInput')?.value || '').trim();
    const display = C.shortDestination ? C.shortDestination(value, 46) : value;
    return display || fallback;
  }

  function validateDestination(showMessage=false){
    const input = qs('#destinationInput');
    const value = input?.value || '';
    const check = C.destinationValidation
      ? C.destinationValidation(value)
      : {valid:(value || '').trim().length >= 2, value:(value || '').trim(), message:'Enter a destination to see your best pickup.'};
    const box = qs('#tripPlannerSummary');
    if(input){
      input.classList.toggle('input-error', !!check.value && !check.valid);
    }
    if(showMessage && box && !check.valid){
      box.classList.remove('hidden', 'confirmed');
      box.classList.add('validation-error');
      box.innerHTML = `<small>Destination needed</small><strong>Check destination</strong><span>${safeText(check.message || 'Enter a real suburb, venue, street or address.')}</span>`;
    }else if(box && check.valid){
      box.classList.remove('validation-error');
    }
    return check;
  }

  function persistDestination(value){
    const check = C.destinationValidation ? C.destinationValidation(value) : {valid:!!String(value || '').trim(), value:String(value || '').trim()};
    const cleaned = check.value || '';
    if(cleaned && check.valid){
      C.saveDestination?.(cleaned);
    }else{
      C.clearDestination?.();
    }
    return cleaned;
  }

  function hydrateDestination(){
    const input = qs('#destinationInput');
    if(!input) return;
    const params = new URLSearchParams(window.location.search);
    const fromQuery = params.has('destination') ? params.get('destination') || '' : '';
    const destination = C.cleanDestination ? C.cleanDestination(fromQuery) : fromQuery.trim();
    if(destination){
      input.value = destination.slice(0, C.destinationMaxLength || 80);
      const check = validateDestination(false);
      if(check.valid) persistDestination(input.value);
      return;
    }
    input.value = '';
    C.clearDestination?.();
  }

  function listForMode(mode){
    const list = scoredPickups();
    if(mode === 'fastest') return [...list].sort((a,b) => a.walk_min - b.walk_min || b.total_score - a.total_score);
    if(mode === 'quiet') return [...list].sort((a,b) => b.congestion_score - a.congestion_score || b.total_score - a.total_score);
    if(mode === 'accessible') return [...list].sort((a,b) => b.accessibility_score - a.accessibility_score || a.walk_min - b.walk_min);
    return list;
  }

  function fitMap(){
    if(!state.mapData || !state.liveMap) return;
    const pickups = scoredPickups();
    const user = state.userLocation ? [[state.userLocation.lat, state.userLocation.lng]] : [];
    const pts = [[state.mapData.stadium.lat,state.mapData.stadium.lng], ...user, ...pickups.slice(0,10).map(p=>[p.lat,p.lng])];
    state.liveMap.fitBounds(pts, {paddingTopLeft:[380,80], paddingBottomRight:[520,80], maxZoom:16});
  }
  function setPlannerStep(step){
    state.activeStep = step;
    qsa('.trip-flow-mini [data-step]').forEach(btn => btn.classList.toggle('active', btn.dataset.step === step));
  }

  function fallbackWalkingRoute(p){
    if(!state.mapData) return [];
    const startPoint = originPoint();
    const start = [startPoint.lat, startPoint.lng];
    const end = [p.lat, p.lng];
    const midA = [start[0], end[1]];
    const midB = [start[0] + ((end[0] - start[0]) * 0.58), end[1]];
    return [start, midA, midB, end];
  }

  function originPoint(){
    return state.userLocation || state.mapData?.user_location || state.mapData?.stadium;
  }

  function directionFromStep(step){
    const maneuver = step?.maneuver || {};
    const type = String(maneuver.type || 'continue').replaceAll('_', ' ');
    const modifier = maneuver.modifier ? ` ${String(maneuver.modifier).replaceAll('_', ' ')}` : '';
    const road = step?.name ? ` onto ${step.name}` : '';
    const distance = step?.distance ? ` (${Math.round(step.distance)} m)` : '';
    return `${type}${modifier}${road}${distance}`;
  }

  function renderRouteDirections(p, routeSteps=[], fallback=false){
    const box = qs('#tripPlannerSummary');
    if(!box || !p) return;
    const dest = destinationValue();
    const venueName = state.userLocation ? 'My location' : (state.mapData?.venue?.name || state.mapData?.stadium?.name || 'the venue');
    const stepText = routeSteps.length
      ? routeSteps.slice(0,3).map(directionFromStep)
      : [`Exit ${venueName}`, `Walk toward ${p.label}`, 'Meet your cab at the selected pickup'];
    box.classList.remove('hidden');
    box.innerHTML = `
      <small>Your exit plan</small>
      <strong>${safeText(p.label)}</strong>
      <span>${safeText(p.walk_min)} min walk - live score ${Math.round(p.total_score || p.score || 0)}<br>Destination: ${safeText(dest)}</span>
      <ol class="mini-route-steps">
        ${stepText.map((s,i)=>`<li><b>${i+1}</b><span>${safeText(s)}</span></li>`).join('')}
      </ol>
      <em>${fallback ? 'Approximate walking line shown. Live street routing was unavailable.' : 'Walking route follows nearby streets where routing data is available.'}</em>`;
  }

  function drawRouteMarkers(coords){
    state.routeMarkerLayer?.clearLayers();
    if(!coords.length || !state.routeMarkerLayer) return;
    coords.slice(1, -1).slice(0, 4).forEach((point, index) => {
      L.circleMarker(point, {
        radius: 5,
        color: '#07111d',
        weight: 2,
        fillColor: '#71ffd3',
        fillOpacity: 1
      }).addTo(state.routeMarkerLayer).bindPopup(`Turn point ${index + 1}`);
    });
  }

  async function drawWalkingRoute(p){
    if(!state.liveMap || !state.mapData || !p) return;
    if(state.routeLine){ state.liveMap.removeLayer(state.routeLine); state.routeLine = null; }
    const start = originPoint();
    const browserRouteUrl = `https://router.project-osrm.org/route/v1/foot/${encodeURIComponent(start.lng)},${encodeURIComponent(start.lat)};${encodeURIComponent(p.lng)},${encodeURIComponent(p.lat)}?overview=full&geometries=geojson&steps=true`;
    const proxyRouteUrl = `/api/walking-route?start_lat=${encodeURIComponent(start.lat)}&start_lng=${encodeURIComponent(start.lng)}&end_lat=${encodeURIComponent(p.lat)}&end_lng=${encodeURIComponent(p.lng)}`;
    try{
      let coords;
      let routeSteps = [];
      try{
        const response = await fetch(browserRouteUrl, {cache:'no-store'});
        if(!response.ok) throw new Error(`Browser route ${response.status}`);
        const data = await response.json();
        const route = data.routes?.[0];
        coords = route?.geometry?.coordinates?.map(([lng, lat]) => [lat, lng]);
        routeSteps = route?.legs?.[0]?.steps || [];
        if(!coords?.length) throw new Error('No browser route geometry');
      }catch(browserError){
        const response = await fetch(proxyRouteUrl, {cache:'no-store'});
        if(!response.ok) throw new Error(`Route ${response.status}`);
        const data = await response.json();
        coords = data.coords;
        routeSteps = data.steps || [];
        if(!coords?.length) throw new Error('No route geometry');
      }
      state.routeSteps = routeSteps;
      state.routeFallback = false;
      state.routeLine = L.polyline(coords, {className:'walking-route-line', weight:7, opacity:.95}).addTo(state.liveMap);
      drawRouteMarkers(coords);
      renderRouteDirections(p, state.routeSteps, false);
    }catch(error){
      const coords = fallbackWalkingRoute(p);
      state.routeSteps = [];
      state.routeFallback = true;
      state.routeLine = L.polyline(coords, {className:'walking-route-line fallback-route-line', weight:7, opacity:.9, dashArray:'12 10'}).addTo(state.liveMap);
      drawRouteMarkers(coords);
      renderRouteDirections(p, [], true);
    }
  }

  function updateTripPlannerSummary(p, confirmed=false){
    const box = qs('#tripPlannerSummary');
    if(!box || !p) return;
    renderRouteDirections(p, state.routeSteps, state.routeFallback);
    box.classList.toggle('confirmed', !!confirmed);
    if(confirmed){
      const heading = box.querySelector('small');
      if(heading) heading.textContent = 'Pickup confirmed - your exit plan';
    }
  }

  function selectPickup(p, pan=false){
    if(!p || !state.liveMap || !state.mapData) return;
    state.selectedZone = p;
    qs('#selectedStrip')?.classList.remove('validation-error');
    Object.entries(state.pickupMarkerMap).forEach(([zone, marker]) => {
      const pickup = scoredPickups().find(x=>x.zone===zone);
      marker.setIcon(markerIcon('pickup', zone === p.zone ? 'selected' : (pickup?.crowd || 'easy')));
    });
    drawWalkingRoute(p);
    state.pickupMarkerMap[p.zone]?.openPopup();
    if(pan) state.liveMap.flyTo([p.lat,p.lng], 17, {animate:true, duration:.6});
    const strip = qs('#selectedStrip');
    if(strip){
      const gpsStart = state.userLocation
        ? `<div class="selected-origin-card"><small>Starting from</small><strong>My location</strong><span>This pickup is ranked from your current GPS position.</span></div>`
        : '';
      const confirmText = state.userLocation ? 'Start ride from My location' : 'Confirm pickup';
      strip.innerHTML = `<div><small>Selected pickup</small><strong>${safeText(p.label)}</strong></div><div class="selected-stats"><span>${safeText(p.walk_min)} min walk</span><span>${Math.round(p.total_score || 0)} live score</span><span>${p.nearby_qldtraffic_events_count || 0} events</span></div><p>${routeReason(p)}</p>${gpsStart}<button class="confirm-pickup-btn">${confirmText}</button>`;
    }
    renderMyLocationRideCard();
    setPlannerStep('choose');
  }

  function renderRecommendations(mode='best'){
    const list = qs('#recommendationList');
    if(!list || !state.mapData) return;
    const recs = (listForMode(mode) || []).slice(0,8);
    list.innerHTML = recs.map((p,i)=>`
      <button class="rec-card pickup-option-card ${i === 0 ? 'recommended-option' : 'alternate-option'} ${state.selectedZone && state.selectedZone.zone===p.zone?'selected':''}" data-zone="${safeText(p.zone)}">
        <span class="rec-badge">${i+1}</span>
        <span class="option-main"><span class="option-kicker">${i === 0 ? 'Recommended pickup point' : 'Alternate pickup location'}</span><h3>${safeText(p.label)}</h3><p>${safeText(p.walk_min)} min walk - score ${Math.round(p.total_score || 0)}</p><small>${routeReason(p)}</small></span>
        <span class="rec-meta"><em class="crowd-pill ${crowdClass(p.crowd)}">${p.nearby_qldtraffic_events_count ? 'Live event' : customerLabelCrowd(p.crowd)}</em><small>${Math.round(p.driver_access_score || 0)} driver access</small></span>
      </button>`).join('');
    qsa('.rec-card', list).forEach(btn => btn.addEventListener('click', () => {
      const p = scoredPickups().find(x=>x.zone===btn.dataset.zone);
      selectPickup(p, true);
      renderRecommendations(mode);
    }));
  }

  function renderMapFeed(mode='best'){
    if(!state.mapData || !state.markerLayer) return;
    state.markerLayer.clearLayers();
    state.trafficLayer?.clearLayers();
    state.pickupMarkerMap = {};
    const venue = state.mapData.venue || state.mapData.stadium;
    L.marker([venue.lat,venue.lng], {icon:markerIcon('stadium')}).addTo(state.markerLayer).bindPopup(`<b>${safeText(venue.name || 'Event venue')}</b><br>Event pickup starts here`);
    const pickups = scoredPickups();
    pickups.forEach(p => {
      const marker = L.marker([p.lat,p.lng], {icon:markerIcon('pickup', p.crowd)}).addTo(state.markerLayer)
        .bindPopup(`<b>${safeText(p.label)}</b><br>${safeText(p.walk_min)} min walk - score ${Math.round(p.total_score || 0)}<br>${routeReason(p)}`)
        .on('click',()=>{ selectPickup(p, true); renderRecommendations(qs('.tab-btn.active')?.dataset.mode || 'best'); });
      state.pickupMarkerMap[p.zone] = marker;
    });
    (state.mapData.cabs || []).slice(0,45).forEach(c=>{
      L.marker([c.lat,c.lng], {icon:markerIcon('cab')}).addTo(state.markerLayer).bindPopup(`<b>${safeText(c.company)}</b><br>${safeText(c.eta)} min ETA`);
    });
    (state.mapData.traffic_events || []).forEach(event => {
      L.marker([event.latitude,event.longitude], {icon:trafficIcon(event.type), zIndexOffset:700}).addTo(state.trafficLayer)
        .bindPopup(`<b>${safeText(String(event.type || 'info').replace('_',' '))}</b><br>${safeText(event.description || 'Traffic event')}`);
    });
    renderUserLocationMarker(false);
    fitMap();
    selectPickup(pickups[0], false);
    renderRecommendations(mode);
  }
  function syncVenueSelect(){
    const known = (state.mapData?.venues || []).map(v => v.venue_id);
    const saved = localStorage.getItem(VENUE_STORAGE_KEY);
    state.venueId = known.includes(state.venueId) ? state.venueId : known.includes(saved) ? saved : 'suncorp_stadium';
    const label = qs('#venuePickerLabel');
    if(label) label.textContent = venueLabel(state.venueId);
    qsa('[data-venue-id]').forEach(option => {
      const selected = option.dataset.venueId === state.venueId;
      option.classList.toggle('selected', selected);
      option.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }
  function renderVenueOptions(){
    const options = qs('#venueOptions');
    if(!options) return;
    const venues = state.mapData?.venues?.length ? state.mapData.venues : Object.values(VENUE_ANCHORS);
    const venueButtons = venues.map(venue => `
      <button type="button" role="option" data-venue-id="${venue.venue_id}">
        ${safeText(venue.name || venue.short_name || venue.venue_id)}
      </button>`).join('');
    options.innerHTML = `
      <button type="button" role="option" class="use-location-option" id="useMyLocationBtn">Use my location</button>
      ${venueButtons}`;
    qs('#useMyLocationBtn')?.addEventListener('click', event => {
      event.preventDefault();
      qs('#venuePicker')?.classList.remove('open');
      qs('#venuePickerButton')?.setAttribute('aria-expanded', 'false');
      useMyLocation();
    });
  }
  function showVenueLoading(mode='best'){
    const anchor = venueAnchor(state.venueId);
    if(state.routeLine){ state.liveMap?.removeLayer(state.routeLine); state.routeLine = null; }
    state.routeSteps = [];
    state.routeFallback = false;
    state.selectedZone = null;
    state.markerLayer?.clearLayers();
    state.trafficLayer?.clearLayers();
    state.routeMarkerLayer?.clearLayers();
    state.pickupMarkerMap = {};
    if(state.liveMap && anchor){
      state.liveMap.setView([anchor.lat, anchor.lng], 15, {animate:true});
      L.marker([anchor.lat, anchor.lng], {icon:markerIcon('stadium')})
        .addTo(state.markerLayer)
        .bindPopup(`<b>${safeText(anchor.name || venueLabel(state.venueId))}</b><br>Loading pickup options...`)
        .openPopup();
    }
    renderUserLocationMarker(false);
    const selected = qs('#selectedStrip');
    if(selected){
      selected.innerHTML = `<div><small>Pickup venue</small><strong>${safeText(venueLabel(state.venueId))}</strong></div><p>Loading live pickup options...</p>`;
    }
    renderMyLocationRideCard();
    const list = qs('#recommendationList');
    if(list){
      list.innerHTML = Array.from({length:3}).map((_, index) => `
        <div class="rec-card pickup-option-card loading-card" aria-hidden="true">
          <span class="rec-badge">${index + 1}</span>
          <span class="option-main"><h3>Loading pickup point</h3><p>Checking walking distance and live traffic...</p></span>
        </div>`).join('');
    }
  }
  async function loadVenueData(mode='best'){
    state.venueId = selectedVenueId();
    localStorage.setItem(VENUE_STORAGE_KEY, state.venueId);
    const requestId = ++state.loadRequestId;
    showVenueLoading(mode);
    const mapData = await getJSON(`/api/map-feed?${venueQuery()}`);
    if(requestId !== state.loadRequestId) return;
    state.mapData = mapData;
    state.recommendationData = {
      recommendations: mapData.pickups || [],
      recommended_pickup: mapData.best?.[0] || null,
      realtime: mapData.realtime || {}
    };
    renderVenueOptions();
    syncVenueSelect();
    if(state.liveMap && mapData.venue){
      state.liveMap.setView([mapData.venue.lat, mapData.venue.lng], 15);
    }
    renderMapFeed(mode);
  }

  function setLocationStatus(text, tone=''){
    const el = qs('#myLocationStatus');
    if(!el) return;
    el.textContent = text;
    el.className = tone ? `location-status ${tone}` : 'location-status';
  }

  function renderMyLocationRideCard(){
    const card = qs('#myLocationRideCard');
    if(!card) return;
    if(!state.userLocation){
      card.classList.add('hidden');
      card.style.display = 'none';
      return;
    }
    const pickup = state.selectedZone;
    const accuracy = state.userLocation.accuracy_m ? `GPS accuracy around ${state.userLocation.accuracy_m} m.` : 'Using your current GPS position.';
    const pickupText = pickup
      ? `${pickup.label} is ranked from your current location.`
      : 'Pickup choices are ranked from where you are now.';
    card.classList.remove('hidden');
    card.removeAttribute('hidden');
    card.style.display = 'grid';
    card.innerHTML = `
      <small>Starting from</small>
      <strong>My location</strong>
      <span>${accuracy} ${pickupText}</span>
      <button type="button" id="startFromMyLocationBtn">${pickup ? 'Start ride to selected pickup' : 'Choose pickup from My location'}</button>`;
    qs('#startFromMyLocationBtn')?.addEventListener('click', () => {
      const confirmButton = qs('#selectedStrip .confirm-pickup-btn');
      if(confirmButton) confirmButton.click();
      else if(pickup) selectPickup(pickup, true);
    });
  }

  function renderUserLocationMarker(openPopup=true){
    if(!state.liveMap || !state.markerLayer || !state.userLocation) return;
    if(state.userMarker) state.markerLayer.removeLayer(state.userMarker);
    state.userMarker = L.marker([state.userLocation.lat, state.userLocation.lng], {icon:userLocationIcon(), zIndexOffset:1200})
      .addTo(state.markerLayer)
      .bindPopup('My location');
    if(openPopup) state.userMarker.openPopup();
  }

  function saveUserLocation(location){
    state.userLocation = location;
    try{ localStorage.setItem(USER_LOCATION_STORAGE_KEY, JSON.stringify(location)); }catch(e){}
  }

  function clearUserLocation(){
    state.userLocation = null;
    try{ localStorage.removeItem(USER_LOCATION_STORAGE_KEY); }catch(e){}
    if(state.userMarker && state.markerLayer){
      state.markerLayer.removeLayer(state.userMarker);
      state.userMarker = null;
    }
    setLocationStatus('Using selected venue as start point');
    renderMyLocationRideCard();
  }

  function loadSavedUserLocation(){
    try{
      const saved = JSON.parse(localStorage.getItem(USER_LOCATION_STORAGE_KEY) || 'null');
      if(saved?.lat && saved?.lng) state.userLocation = saved;
    }catch(e){}
  }

  function useMyLocation(){
    const btn = qs('#useMyLocationBtn');
    if(!navigator.geolocation){
      setLocationStatus('GPS is not supported in this browser', 'error');
      return;
    }
    if(btn) btn.disabled = true;
    setLocationStatus('Finding your location...', 'loading');
    navigator.geolocation.getCurrentPosition(position => {
      const location = {
        lat: Number(position.coords.latitude.toFixed(6)),
        lng: Number(position.coords.longitude.toFixed(6)),
        accuracy_m: Math.round(position.coords.accuracy || 0),
        captured_at: new Date().toISOString()
      };
      saveUserLocation(location);
      renderUserLocationMarker(true);
      renderMyLocationRideCard();
      state.liveMap?.flyTo([location.lat, location.lng], 17, {animate:true, duration:.7});
      setLocationStatus(`My location active (${location.accuracy_m} m)`, 'active');
      loadVenueData(qs('.tab-btn.active')?.dataset.mode || 'best').catch(console.error).finally(() => {
        if(btn) btn.disabled = false;
      });
    }, error => {
      const message = error.code === error.PERMISSION_DENIED ? 'Location permission was blocked' : 'Could not get current location';
      setLocationStatus(message, 'error');
      if(btn) btn.disabled = false;
    }, {enableHighAccuracy:true, timeout:10000, maximumAge:30000});
  }

  function initLiveMap(){
    const el = qs('#liveMap');
    if(!el || !window.L) return;
    hydrateDestination();
    const params = new URLSearchParams(window.location.search);
    const venueFromQuery = params.get('venue_id');
    const savedVenue = localStorage.getItem(VENUE_STORAGE_KEY);
    if(venueFromQuery){
      state.venueId = venueFromQuery;
      localStorage.setItem(VENUE_STORAGE_KEY, venueFromQuery);
    }else if(savedVenue) state.venueId = savedVenue;
    loadSavedUserLocation();
    if(state.userLocation) setLocationStatus('My location active', 'active');
    state.liveMap = L.map(el, { zoomControl:true, attributionControl:true }).setView([-27.4648,153.0095], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19, attribution:'OpenStreetMap'}).addTo(state.liveMap);
    state.markerLayer = L.layerGroup().addTo(state.liveMap);
    state.trafficLayer = L.layerGroup().addTo(state.liveMap);
    state.routeMarkerLayer = L.layerGroup().addTo(state.liveMap);
    loadVenueData('best').catch(console.error);
    const picker = qs('#venuePicker');
    const pickerButton = qs('#venuePickerButton');
    const options = qs('#venueOptions');
    pickerButton?.addEventListener('click', () => {
      const open = picker?.classList.toggle('open');
      pickerButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    options?.addEventListener('click', event => {
      const option = event.target.closest('[data-venue-id]');
      if(!option) return;
      state.venueId = option.dataset.venueId;
      clearUserLocation();
      localStorage.setItem(VENUE_STORAGE_KEY, state.venueId);
      picker?.classList.remove('open');
      pickerButton?.setAttribute('aria-expanded', 'false');
      syncVenueSelect();
      setPlannerStep('plan');
      loadVenueData(qs('.tab-btn.active')?.dataset.mode || 'best').catch(console.error);
    });
    document.addEventListener('click', event => {
      if(!picker?.contains(event.target)){
        picker?.classList.remove('open');
        pickerButton?.setAttribute('aria-expanded', 'false');
      }
    });
    qs('#recenterMap')?.addEventListener('click',()=>{
      const check = validateDestination(true);
      if(!check.valid){
        qs('#destinationInput')?.focus();
        return;
      }
      persistDestination(check.value);
      const first = scoredPickups()[0];
      if(first){ setPlannerStep('choose'); selectPickup(first, true); fitMap(); }
    });
    qsa('.tab-btn').forEach(btn=>btn.addEventListener('click',()=>{
      qsa('.tab-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      renderRecommendations(btn.dataset.mode);
    }));
  }

  function initHomePreview(){
    const el = qs('#homePreviewMap');
    if(!el || !window.L) return;
    const map = L.map(el, {zoomControl:false, attributionControl:false, dragging:false, scrollWheelZoom:false, doubleClickZoom:false}).setView([-27.4705,153.0260], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:18}).addTo(map);
    const previewLayer = L.layerGroup().addTo(map);
    const venueSelect = qs('#homeVenueSelect');
    let latestRequest = 0;
    const loggedIn = (document.body?.dataset?.role || 'guest') !== 'guest';
    if(!loggedIn){
      qs('#homeBestZone').textContent = 'Login to unlock';
      qs('#homeBestWalk').textContent = '-- min';
      qs('#homeBestEta').textContent = '-- min';
      qs('#homeLiveStatus').textContent = 'Secure planning';
      return;
    }
    const savedPreviewVenue = localStorage.getItem(VENUE_STORAGE_KEY) || venueSelect?.value || 'suncorp_stadium';
    if(venueSelect){
      venueSelect.value = savedPreviewVenue;
    }
    const loadPreview = venueId => {
      const requestId = ++latestRequest;
      const selectedVenue = venueId || venueSelect?.value || 'suncorp_stadium';
      previewLayer.clearLayers();
      qs('#homeBestZone').textContent = 'Loading...';
      qs('#homeBestWalk').textContent = '-- min';
      qs('#homeBestEta').textContent = '-- min';
      qs('#homeLiveStatus').textContent = 'Loading';
      getJSON(`/api/map-preview?venue_id=${encodeURIComponent(selectedVenue)}`).then(data=>{
        if(requestId !== latestRequest) return;
        L.marker([data.stadium.lat,data.stadium.lng], {icon:markerIcon('stadium')}).addTo(previewLayer);
        data.pickups.slice(0,9).forEach(p=>L.marker([p.lat,p.lng], {icon:markerIcon('pickup', p.crowd)}).addTo(previewLayer));
        (data.cabs || []).slice(0,15).forEach(c=>L.marker([c.lat,c.lng], {icon:markerIcon('cab')}).addTo(previewLayer));
        const best = data.best[0];
        if(best){
          qs('#homeBestZone').textContent = best.label;
          qs('#homeBestWalk').textContent = best.walk_min + ' min';
          qs('#homeBestEta').textContent = best.eta + ' min';
          qs('#homeLiveStatus').textContent = best.crowd === 'busy' ? 'Busy exits' : best.crowd === 'medium' ? 'Balanced flow' : 'Smooth flow';
        }
        const pts = [[data.stadium.lat,data.stadium.lng], ...data.pickups.slice(0,9).map(p=>[p.lat,p.lng])];
        map.fitBounds(pts,{padding:[45,45],maxZoom:15});
      }).catch(() => {
        if(requestId !== latestRequest) return;
        qs('#homeBestZone').textContent = 'Open Live Map';
        qs('#homeBestWalk').textContent = '-- min';
        qs('#homeBestEta').textContent = '-- min';
        qs('#homeLiveStatus').textContent = 'Ready';
      });
    };
    window.addEventListener('crowdcab:homeVenueChanged', event => loadPreview(event.detail?.venueId));
    loadPreview(savedPreviewVenue);
  }

  C.onReady(()=>{
    initHomePreview();
    initLiveMap();
    qs('#destinationInput')?.addEventListener('input',()=>{
      C.clampDestinationInput?.(qs('#destinationInput'));
      validateDestination(false);
      persistDestination(qs('#destinationInput')?.value || '');
      setPlannerStep('plan');
      if(state.selectedZone) renderRouteDirections(state.selectedZone, state.routeSteps, state.routeFallback);
    });
  });

  window.CrowdCabMap = {
    state, selectPickup, setPlannerStep,
    getSelectedZone: () => state.selectedZone,
    getSelectedVenue: () => state.mapData?.venue || state.mapData?.stadium || null,
    getSelectedVenueId: () => state.venueId,
    getSelectedVenueName: () => venueLabel(state.venueId),
    getUserLocation: () => state.userLocation,
    getRouteLine: () => state.routeLine,
    getLiveMap: () => state.liveMap,
    updateTripPlannerSummary
  };
})();

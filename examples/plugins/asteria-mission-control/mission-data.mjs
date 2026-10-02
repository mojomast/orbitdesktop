// Public synthetic kit only. Tuples mirror manifest.csv; parity is tested byte-for-byte.
export const INPUT_SHA256 = 'fe5df21cbc03e71a968ff3281017be28b5b85855cf4ad5c6d6f70a8189097d3b';
export const MODEL_VERSION = 'asteria-scenario-1';
export const SOURCES = Object.freeze([
  { id: 'manifest', label: 'Synthetic equipment manifest (raw 25 rows)', href: './data/manifest.csv', sha256: INPUT_SHA256 },
  { id: 'DOC-01', label: 'Mission requirements — Revision A', href: './data/DOC-01.txt', sha256: 'a2ccf163d2e3208edb8ba75274e1fb006ea5a1104e047124fb52930e23a673b6' },
  { id: 'DOC-02', label: 'Supplier assessment — Revision A', href: './data/DOC-02.txt', sha256: 'b86a593f600f006a9dd12cdd7d079e002f0f9b49f65dad6273a1062d46b4b91c' },
  { id: 'DOC-03', label: 'Engineering constraints — Revision B (physical authority)', href: './data/DOC-03.txt', sha256: '0b99ca94d172e09712e9ddf433d532489a029473511ed87bccc37cab4ebaff2d' },
  { id: 'DOC-04', label: 'Operations memo (informal assumptions)', href: './data/DOC-04.txt', sha256: '8e76ba748ec0adf2a9c1a5256ca0fab0deb6f2b23b2eb95f5b6bbe8d6aeeff58' },
].map(Object.freeze));

const tuples = [
  ['habitat','EQU-001','habitat_shell_module','Selene Systems',2,172000,600,0.35,14,'high'],
  ['habitat','EQU-002','airlock_assembly','Kestrel Aerospace',2,62000,210,0.10,12,'medium'],
  ['habitat','EQU-003','interior_outfitting_kit','Meridian Robotics',2,31000,180,0.25,9,'medium'],
  ['habitat','EQU-004','radiation_shielding_panels','Selene Systems',4,17000,95,0,10,'high'],
  ['habitat','EQU-005','crew_sleep_stations','Meridian Robotics',4,10000,70,0.06,8,'low'],
  ['power','EQU-006','solar_array_wing','Apollon Dynamics',4,36000,140,0.05,13,'medium'],
  ['power','EQU-007','regenerative_fuel_cell','Kestrel Aerospace',2,92000,320,0.10,15,'high'],
  ['power','EQU-008','power_distribution_bus','Meridian Robotics',1,46000,150,0.08,8,'low'],
  ['power','EQU-009','battery_bank','Apollon Dynamics',5,19000,110,0.02,11,'medium'],
  ['communications','EQU-010','ka_band_relay_terminal','Kestrel Aerospace',1,78000,95,0.30,12,'medium'],
  ['communications','EQU-011','surface_antenna_mast','Apollon Dynamics',2,26000,60,0.05,9,'low'],
  ['communications','EQU-012','comms_avionics_rack','Meridian Robotics',1,48000,130,0.22,10,'medium'],
  ['communications','EQU-013','emergency_beacon_array','Selene Systems',2,13000,25,0.08,7,'high'],
  ['communications','EQU-014','optical_comms_backup_terminal','Selene Systems',1,38000,85,0.28,16,'high'],
  ['laboratory','EQU-015','sample_analysis_suite','Meridian Robotics',1,110000,260,0.60,16,'high'],
  ['laboratory','EQU-016','cold_storage_unit','Kestrel Aerospace',1,44000,140,0.40,11,'medium'],
  ['laboratory','EQU-017','lab_glovebox_workstation','Meridian Robotics',1,36000,120,0.35,12,'medium'],
  ['laboratory','EQU-018','spectrometer_bench','Selene Systems',1,29000,70,0.20,13,'low'],
  ['logistics','EQU-019','surface_rover','Meridian Robotics',1,86000,480,0.15,14,'high'],
  ['logistics','EQU-020','cargo_pallet_system','Selene Systems',2,21000,160,0.05,9,'low'],
  ['logistics','EQU-021','rover_battery_pack','Kestrel Aerospace',3,14000,45,0.02,null,'medium'],
  ['logistics','EQU-022','surface_navigation_beacon','Apollon Dynamics',2,7000,20,0.04,10,'low'],
  ['life_support','EQU-023','atmosphere_revitalisation_unit','Kestrel Aerospace',2,70000,260,0.45,13,'high'],
  ['life_support','EQU-024','water_reclamation_system','Meridian Robotics',1,61000,210,0.30,12,'high'],
  ['communications','EQU-025','surface_antenna_mast','Apollon Dynamics',2,26000,60,0.05,7,'low'],
];
const fields = ['module','item_id','item','supplier','quantity','unit_cost_usd','unit_cargo_mass_kg','unit_power_demand_kw','lead_time_months','risk_category'];
export const MANIFEST = Object.freeze(tuples.map(row => Object.freeze(Object.fromEntries(fields.map((key, i) => [key, row[i]])))));

export const FLIGHT_LIMIT_KG = 3400;
export const STRATEGY_PLANS = Object.freeze(Object.fromEntries(Object.entries({
  'anchor-first': { crewMonth: 14, fuelCellUpgrade: false, atmosphereUpgrade: false, groups: [['habitat','life_support'],['power','communications','logistics'],['laboratory']] },
  'power-first': { crewMonth: 18, fuelCellUpgrade: false, atmosphereUpgrade: false, groups: [['power','communications'],['habitat','life_support'],['laboratory','logistics']] },
  'parallel-sprint': { crewMonth: 11, fuelCellUpgrade: true, atmosphereUpgrade: false, groups: [['habitat','communications'],['power','life_support'],['laboratory','logistics']] },
}).map(([id, plan]) => [id, Object.freeze({ ...plan, groups: Object.freeze(plan.groups.map(group => Object.freeze(group))) })])));

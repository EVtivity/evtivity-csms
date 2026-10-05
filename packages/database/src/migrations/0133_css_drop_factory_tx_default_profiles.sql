-- Simulated OCPP 2.1 stations no longer leave the factory with a charging
-- profile (a 32 A TxDefaultProfile per EVSE, stack level 0, id = EVSE id).
-- Stations persist their charging profiles, so stations created before that
-- change still hold the factory rows. Delete the rows that are exactly the
-- factory profile. A profile the CSMS set (other id, purpose, limit or any
-- other field) stays. Idempotent: a second run matches no rows.
DELETE FROM css_charging_profiles
WHERE evse_id = profile_id
  AND profile_data = jsonb_build_object(
    'id', profile_id,
    'chargingProfileId', profile_id,
    'stackLevel', 0,
    'chargingProfilePurpose', 'TxDefaultProfile',
    'chargingProfileKind', 'Absolute',
    'chargingSchedule', jsonb_build_array(
      jsonb_build_object(
        'id', profile_id,
        'chargingRateUnit', 'A',
        'chargingSchedulePeriod', jsonb_build_array(
          jsonb_build_object('startPeriod', 0, 'limit', 32, 'numberPhases', 3)
        )
      )
    )
  );

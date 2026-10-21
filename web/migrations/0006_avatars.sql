-- Profile pictures. NULL shows initials; otherwise the picture is at avatars/<user id>/<avatar> in R2.
ALTER TABLE users ADD COLUMN avatar TEXT;

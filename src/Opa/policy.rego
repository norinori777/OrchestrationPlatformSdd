package example.authz

default allow = false

allow if {
  input.user == "alice"
  input.action == "read"
}

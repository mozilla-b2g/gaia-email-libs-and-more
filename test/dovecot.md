Setting up dovecot on Ubuntu
============================

There are lots of ways to set up dovecot to work with the GELAM email tests.
Here's a fairly straightforward way.

First, install dovecot and postfix:

```
sudo apt-get install dovecot-imapd dovecot-postfix
```

Next, create a user named `testy` with password `testy` (or, if you prefer,
create any user you like and use the environment variables `GELAM_TEST_ACCOUNT`
and `GELAM_TEST_PASSWORD` to hold the username and password).

To make this work, you'll also have to modify a few config files:

* in `/etc/dovecot/conf.d/10-mail.conf`, set the following variables:

  ```
  mail_location = sdbox:~/sdbox
  ```

* in `/etc/dovecont/dovecot.conf`, set the following variables:

  ```
  disable_plaintext_auth = no
  listen = 127.0.0.1
  ```

* in `/etc/postbox/main.cf`, set the following variables:

  ```
  smtpd_tls_auth_only = no
  ```

Setting up dovecot on Ubuntu
============================

There are lots of ways to set up dovecot to work with the GELAM email tests.
Here's a fairly straightforward way.

First, install dovecot and postfix:

```
sudo apt-get install dovecot-imapd dovecot-postfix
```

You may be asked to configure postfix! Yay! You don't to talk to anyone over  
the network in order to run the tests, so go ahead and choose 'Local only'.  

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

* in `/etc/postfix/main.cf`, set the following variables:

  ```
  smtpd_tls_auth_only = no
  mydestination = localhost
  mailbox_command = /usr/lib/dovecot/dovecot-lda -f "$SENDER" -a "$RECIPIENT"
  ```

And remember that after you modify the config files, please restart the servers.

Use Thunderbird to connect the Dovecot server, and create the below folders:
* Drafts
* Sent
* Spam

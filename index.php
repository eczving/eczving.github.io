<?php

$output = shell_exec('cat /etc/*release | grep PRETTY_NAME;echo;free -m');
Echo '<pre>$output</pre>';

?>
